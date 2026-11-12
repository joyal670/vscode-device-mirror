(function () {
  'use strict';

  const KIND_VIDEO = 0x01;
  const KIND_IMAGE = 0x02;
  const KIND_AUDIO = 0x03;

  const FLAG_CONFIG = 1;
  const FLAG_KEY = 2;

  const ACTION_DOWN = 0;
  const ACTION_UP = 1;
  const ACTION_MOVE = 2;

  /** Pixels per "line" for wheel events reported in DOM_DELTA_LINE. */
  const WHEEL_LINE_PX = 40;
  /** Wheel pixels per unit of scrcpy scroll. Unchanged from the original tuning. */
  const WHEEL_PX_PER_UNIT = 200;

  const canvas = document.getElementById('screen');
  const input = document.getElementById('input');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const reconnectButton = document.getElementById('reconnect');
  const keysEl = document.getElementById('keys');
  const recBadge = document.getElementById('rec-badge');
  const recTime = document.getElementById('rec-time');
  const recordButton = document.getElementById('record-btn');
  const displayButton = document.getElementById('display-btn');
  const audioBadge = document.getElementById('audio-badge');
  const muteButton = document.getElementById('mute-btn');
  const ctx = canvas.getContext('2d');

  const port = document.body.dataset.port;
  const token = document.body.dataset.token;
  const isMac = document.body.dataset.mac === 'true';

  /**
   * 'scrcpy' | 'screencap' | null. Comes from each 'meta' message rather than
   * the page, because a restart can switch backends without a reload.
   */
  let mode = null;

  let decoder = null;
  let pendingConfig = null; // held SPS/PPS, prepended to the next key frame

  /**
   * Frames still queued in the decoder. Past this, we are showing the past:
   * every queued frame is ~33ms of latency at 30fps, and on a slow machine the
   * queue only grows. Deltas can't be skipped individually (each depends on
   * the last), so drop everything until the next key frame and ask the
   * server for one right away rather than waiting for the scheduled I-frame.
   */
  const MAX_DECODE_QUEUE = 3;
  let waitingForKey = false;
  let socket = null;

  /** True from 'streaming' until the first frame of that session is drawn. */
  let awaitingFirstFrame = false;
  let connectionState = 'connecting';

  /**
   * The coordinate space every pointer event is reported in. This is the
   * ENCODED VIDEO size (after max_size downscaling), not the physical display
   * size — scrcpy's PositionMapper rejects any event whose stamped size does
   * not match the current video size exactly. It changes on rotation, so it is
   * re-read from each decoded frame rather than fetched once at startup.
   */
  let videoSize = { width: 0, height: 0 };
  let cancelGesture = () => {};
  let forgetGesture = () => {};

  function setVideoSize(width, height) {
    if (videoSize.width === width && videoSize.height === height) {
      return;
    }
    videoSize = { width, height };
    canvas.width = width;
    canvas.height = height;
    // A gesture in flight was aimed at the old geometry; continuing it across
    // a rotation would drag to a meaningless point, so drop it.
    cancelGesture();
  }

  function setStatus(text, { showReconnect = false } = {}) {
    reconnectButton.hidden = !showReconnect;
    if (!text) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusText.textContent = text;
  }

  function frameDrawn() {
    if (awaitingFirstFrame) {
      awaitingFirstFrame = false;
      setStatus('');
    }
  }

  function resetDecoder() {
    if (decoder && decoder.state !== 'closed') {
      decoder.close();
    }
    decoder = null;
    pendingConfig = null;
    waitingForKey = false;
  }

  // ---------------------------------------------------------------- transport

  function connect() {
    // The bridge rejects connections without this per-session secret.
    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    socket.binaryType = 'arraybuffer';

    socket.onclose = () => setStatus('Disconnected.');
    socket.onerror = () => setStatus('Bridge connection failed.');

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleJson(JSON.parse(event.data));
        return;
      }
      const view = new Uint8Array(event.data);
      const kind = view[0];
      const flags = view[1];
      const payload = view.subarray(2);

      if (kind === KIND_VIDEO) {
        handleVideoPacket(flags, payload);
      } else if (kind === KIND_IMAGE) {
        handleImage(payload);
      } else if (kind === KIND_AUDIO) {
        audio.handlePacket(flags, payload);
      }
    };
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function handleJson(message) {
    switch (message.type) {
      case 'meta':
        // A new session: whatever the decoder held belongs to the old stream.
        resetDecoder();
        mode = message.mode;
        keysEl.hidden = false;
        keysEl.classList.toggle('view-only', mode !== 'scrcpy');
        setVideoSize(message.width, message.height);
        break;
      case 'state':
        handleState(message.state, message.message);
        break;
      case 'audio':
        audio.setState(message.state, message.reason);
        break;
      case 'recording':
        setRecording(message.active, message.startedAt);
        break;
      case 'display':
        displayButton.classList.toggle('active', !message.on);
        displayButton.title = message.on
          ? 'Turn device screen off (keeps mirroring)'
          : 'Turn device screen back on';
        break;
    }
  }

  function handleState(state, message) {
    connectionState = state;
    if (state === 'connecting') {
      awaitingFirstFrame = false;
      setStatus('Connecting…');
    } else if (state === 'streaming') {
      awaitingFirstFrame = true;
      setStatus('Waiting for first frame…');
    } else if (state === 'disconnected') {
      awaitingFirstFrame = false;
      // The session that owned this gesture is gone; don't send it an UP.
      forgetGesture();
      resetDecoder();
      audio.reset();
      setStatus(message || 'Disconnected.', { showReconnect: true });
    }
  }

  reconnectButton.addEventListener('click', () => {
    reconnectButton.hidden = true;
    setStatus('Reconnecting…');
    send({ type: 'reconnect' });
  });

  // ---------------------------------------------------------------- recording

  let recTimer = null;

  function setRecording(active, startedAt) {
    recBadge.hidden = !active;
    recordButton.classList.toggle('active', !!active);
    recordButton.title = active ? 'Stop screen recording and save' : 'Start screen recording';
    clearInterval(recTimer);
    recTimer = null;
    if (active) {
      const tick = () => {
        const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        recTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      };
      tick();
      recTimer = setInterval(tick, 1000);
    }
  }

  // -------------------------------------------------------------- tier 0 path

  async function handleImage(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    setVideoSize(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    frameDrawn();
  }

  // -------------------------------------------------------------- tier 1 path

  /** Walk an Annex B buffer and return the first NAL accepted by `match`. */
  function findNal(bytes, match) {
    for (let i = 0; i + 4 < bytes.length; i++) {
      const isStart3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
      const isStart4 =
        bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
      if (!isStart3 && !isStart4) continue;
      const offset = i + (isStart4 ? 4 : 3);
      if (match(bytes[offset])) {
        return bytes.subarray(offset);
      }
    }
    return null;
  }

  const hex = (b) => b.toString(16).padStart(2, '0');

  function configureDecoder(configBytes) {
    const sps = findNal(configBytes, (h) => (h & 0x1f) === 7);
    // avc1.<profile_idc><constraint_flags><level_idc>, each as two hex digits.
    // Chromium rejects a string that doesn't match the stream's profile.
    const codecName = sps ? 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]) : 'avc1.42E01E';

    if (decoder && decoder.state !== 'closed') {
      decoder.close();
    }

    decoder = new VideoDecoder({
      output: (frame) => {
        // Rotation arrives as a fresh SPS and re-sized frames; this is what
        // keeps the touch coordinate space in step with it.
        setVideoSize(frame.displayWidth, frame.displayHeight);
        ctx.drawImage(frame, 0, 0);
        frame.close();
        frameDrawn();
      },
      error: (err) => setStatus(`Decoder error: ${err.message}`),
    });

    // No `description` => the decoder treats the bitstream as Annex B, so we
    // can feed scrcpy's output straight through without muxing to fMP4.
    decoder.configure({ codec: codecName, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  function handleVideoPacket(flags, payload) {
    const isConfig = (flags & FLAG_CONFIG) !== 0;
    const isKey = (flags & FLAG_KEY) !== 0;

    if (isConfig) {
      pendingConfig = payload.slice();
      configureDecoder(pendingConfig);
      return;
    }

    if (!decoder || decoder.state !== 'configured') {
      return; // nothing decodable until the config packet has arrived
    }

    if (isKey) {
      waitingForKey = false;
    } else if (waitingForKey) {
      return;
    } else if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      waitingForKey = true;
      send({ type: 'resetVideo' });
      return;
    }

    let data = payload;
    if (pendingConfig && isKey) {
      // A config packet is not itself a decodable frame; splice it onto the
      // next key frame instead of submitting it alone.
      data = new Uint8Array(pendingConfig.length + payload.length);
      data.set(pendingConfig, 0);
      data.set(payload, pendingConfig.length);
      pendingConfig = null;
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data,
        }),
      );
    } catch (err) {
      setStatus(`Decode failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------- audio

  /**
   * Raw PCM from the device (s16le, stereo, 48 kHz) -> Web Audio.
   *
   * No decoding: VS Code's Electron has no WebCodecs audio decoders, which is
   * why the host asks scrcpy for raw audio in the first place.
   *
   * Browsers only let an AudioContext start after a user gesture, so packets
   * that arrive before the first click are dropped.
   */
  const audio = (() => {
    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    /** Keep at most this much audio queued; beyond it, resync to "now". */
    const MAX_AHEAD_S = 0.25;
    const START_DELAY_S = 0.04;

    let state = 'off'; // off | pending | on | unavailable
    let context = null;
    let gain = null;
    let nextTime = 0;
    let muted = false;
    /** Odd trailing byte from a packet that split a sample. Rare, but cheap to handle. */
    let carry = null;

    function wantAudio() {
      return state === 'on' || state === 'pending';
    }

    function render() {
      const blocked = wantAudio() && (!context || context.state !== 'running');
      audioBadge.hidden = !blocked || state !== 'on';
      muteButton.hidden = !wantAudio();
      muteButton.classList.toggle('active', muted);
      muteButton.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
      muteButton.title = muted ? 'Unmute device audio' : 'Mute device audio';
    }

    /** Must run inside a user gesture the first time. */
    function unlock() {
      if (!wantAudio()) return;
      if (!context) {
        context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
        gain = context.createGain();
        gain.gain.value = muted ? 0 : 1;
        gain.connect(context.destination);
        context.onstatechange = render;
      }
      if (context.state !== 'running') {
        context.resume().then(render, render);
      }
      render();
    }

    function play(bytes) {
      if (carry) {
        const joined = new Uint8Array(carry.length + bytes.length);
        joined.set(carry, 0);
        joined.set(bytes, carry.length);
        bytes = joined;
        carry = null;
      }
      const frameBytes = 2 * CHANNELS;
      const usable = bytes.length - (bytes.length % frameBytes);
      if (usable < bytes.length) carry = bytes.slice(usable);
      const frames = usable / frameBytes;
      if (frames === 0) return;

      const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
      const buffer = context.createBuffer(CHANNELS, frames, SAMPLE_RATE);
      for (let ch = 0; ch < CHANNELS; ch++) {
        const out = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          out[i] = view.getInt16((i * CHANNELS + ch) * 2, true) / 32768;
        }
      }

      const now = context.currentTime;
      // Too little queued risks gaps; too much is lag. Either way, restart
      // the schedule just ahead of now rather than drift.
      if (nextTime < now || nextTime > now + MAX_AHEAD_S) {
        nextTime = now + START_DELAY_S;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(nextTime);
      nextTime += buffer.duration;
      api.framesPlayed += frames;
    }

    const api = {
      /** Sample frames scheduled so far; handy when debugging silence. */
      framesPlayed: 0,
      setState(next, reason) {
        state = next;
        if (next === 'unavailable') {
          console.info('device audio unavailable:', reason);
        }
        render();
      },
      handlePacket(flags, payload) {
        if ((flags & FLAG_CONFIG) !== 0) return; // raw PCM has no real config
        if (muted || !context || context.state !== 'running') return;
        play(payload);
      },
      reset() {
        nextTime = 0;
        carry = null;
        render();
      },
      unlock,
      toggleMute() {
        muted = !muted;
        if (gain) gain.gain.value = muted ? 0 : 1;
        render();
      },
    };
    return api;
  })();
  // Exposed read-only for debugging from devtools.
  Object.defineProperty(window, 'deviceMirrorAudioFrames', { get: () => audio.framesPlayed });

  audioBadge.addEventListener('click', () => audio.unlock());
  muteButton.addEventListener('click', () => {
    audio.unlock();
    audio.toggleMute();
  });
  // Any interaction with the mirror counts as the gesture that allows audio.
  document.addEventListener('pointerdown', () => audio.unlock(), true);
  document.addEventListener('keydown', () => audio.unlock(), true);

  // ------------------------------------------------------------------- input

  /**
   * Map a DOM event to a point in the current video frame. Returns the size it
   * was measured against so the host can stamp it on the wire — if a rotation
   * lands between here and the device, the mismatch makes the server discard
   * the event instead of applying it to the wrong geometry.
   */
  let lastFraction = { fx: 0, fy: 0 };

  function fractionOf(event) {
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const fy = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
  }

  function toVideoPoint(event) {
    lastFraction = fractionOf(event);
    return pointInCurrentFrame(lastFraction);
  }

  function pointInCurrentFrame({ fx, fy }) {
    return {
      x: Math.round(fx * videoSize.width),
      y: Math.round(fy * videoSize.height),
      w: videoSize.width,
      h: videoSize.height,
    };
  }

  /** The pinch partner: the pointer reflected through the screen centre. */
  function mirroredPoint({ fx, fy }) {
    return pointInCurrentFrame({ fx: 1 - fx, fy: 1 - fy });
  }

  /**
   * Real pressure from a pen or pressure-sensitive touchscreen, else
   * undefined (the host then sends full pressure). Mice report a constant 0.5
   * while a button is held, and so does touch hardware that can't measure
   * pressure, so 0.5 is treated as "unknown" rather than "half".
   */
  function pressureOf(event) {
    if (event.pointerType === 'mouse') return undefined;
    if (!(event.pressure > 0) || event.pressure === 0.5) return undefined;
    return event.pressure;
  }

  /** Normalise any wheel deltaMode to pixels. */
  function wheelPixels(event, delta) {
    if (event.deltaMode === 1) return delta * WHEEL_LINE_PX; // DOM_DELTA_LINE
    if (event.deltaMode === 2) return delta * canvas.getBoundingClientRect().height; // DOM_DELTA_PAGE
    return delta; // DOM_DELTA_PIXEL
  }

  /** Input only goes anywhere while a scrcpy session is actually up. */
  function inputEnabled() {
    return mode === 'scrcpy' && connectionState === 'streaming' && videoSize.width > 0;
  }

  function focusInput() {
    // The hidden textarea, not the canvas, takes keyboard focus: only an
    // editable element gets IME composition and native copy/paste events.
    input.focus({ preventScroll: true });
  }

  let down = false;
  /** True while an Alt+drag pinch is in progress (two fingers down). */
  let pinching = false;

  function touch(action, point, extra) {
    send({ type: 'touch', action, ...point, ...extra });
  }

  /**
   * Called by setVideoSize() when the device rotates mid-gesture.
   *
   * The release is stamped with the NEW size, not the one the gesture
   * started in: setVideoSize() updates videoSize before calling this, and an
   * event carrying a stale size is rejected by the server — which would
   * leave the pointer stuck down on the device. Releasing at a remapped
   * position is arbitrary, but it is better than a dragged finger teleporting
   * across the rotated layout and triggering a fling.
   */
  cancelGesture = () => {
    if (!down) return;
    down = false;
    touch(ACTION_UP, pointInCurrentFrame(lastFraction));
    if (pinching) {
      pinching = false;
      touch(ACTION_UP, mirroredPoint(lastFraction), { finger: 1 });
    }
  };

  /** Drop a gesture without telling the device (its session is gone). */
  forgetGesture = () => {
    down = false;
    pinching = false;
  };

  canvas.addEventListener('pointerdown', (event) => {
    focusInput();
    if (!inputEnabled()) return;
    if (event.button === 1) {
      // Middle click: Home, as in scrcpy.
      event.preventDefault();
      send({ type: 'key', keycode: 3, action: 'press' });
      return;
    }
    if (event.button !== 0) return; // right button handled by contextmenu
    canvas.setPointerCapture(event.pointerId);
    down = true;
    pinching = event.altKey;
    touch(ACTION_DOWN, toVideoPoint(event), { pressure: pressureOf(event) });
    if (pinching) {
      touch(ACTION_DOWN, mirroredPoint(lastFraction), { finger: 1 });
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!down) return;
    touch(ACTION_MOVE, toVideoPoint(event), { pressure: pressureOf(event) });
    if (pinching) {
      touch(ACTION_MOVE, mirroredPoint(lastFraction), { finger: 1 });
    }
  });

  const release = (event) => {
    if (!down) return;
    down = false;
    touch(ACTION_UP, toVideoPoint(event));
    if (pinching) {
      pinching = false;
      touch(ACTION_UP, mirroredPoint(lastFraction), { finger: 1 });
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Right click: Back (or wake the screen if it's off), as in scrcpy.
  canvas.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (inputEnabled()) send({ type: 'action', name: 'backOrScreenOn' });
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (!inputEnabled()) return;
      send({
        type: 'scroll',
        ...toVideoPoint(event),
        hscroll: -wheelPixels(event, event.deltaX) / WHEEL_PX_PER_UNIT,
        vscroll: -wheelPixels(event, event.deltaY) / WHEEL_PX_PER_UNIT,
      });
    },
    { passive: false },
  );

  // ---------------------------------------------------------------- keyboard

  /** KeyboardEvent.code -> Android KeyEvent keycode. */
  const KEYCODES = {
    Enter: 66, NumpadEnter: 160, Backspace: 67, Tab: 61, Space: 62, Escape: 111,
    Delete: 112, Insert: 124, Home: 122, End: 123, PageUp: 92, PageDown: 93,
    ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72, Backslash: 73,
    Semicolon: 74, Quote: 75, Comma: 55, Period: 56, Slash: 76, Backquote: 68,
    ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114,
    AltLeft: 57, AltRight: 58, MetaLeft: 117, MetaRight: 118, CapsLock: 115,
    ContextMenu: 82,
  };
  for (let i = 0; i < 26; i++) KEYCODES['Key' + String.fromCharCode(65 + i)] = 29 + i;
  for (let i = 0; i < 10; i++) {
    KEYCODES['Digit' + i] = 7 + i;
    KEYCODES['Numpad' + i] = 144 + i;
  }
  for (let i = 1; i <= 12; i++) KEYCODES['F' + i] = 130 + i;

  /** Keys that never produce text, so they always go as keycodes. */
  const NON_TEXT = new Set([
    'Enter', 'NumpadEnter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert',
    'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
    'ArrowRight', 'ContextMenu',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ]);
  const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'CapsLock',
  ]);

  /** Android KeyEvent meta-state bits for the held modifiers. */
  function metaState(event) {
    let meta = 0;
    if (event.shiftKey) meta |= 0x1 | 0x40; // SHIFT_ON | SHIFT_LEFT_ON
    if (event.altKey) meta |= 0x2 | 0x10; // ALT_ON | ALT_LEFT_ON
    if (event.ctrlKey) meta |= 0x1000 | 0x2000; // CTRL_ON | CTRL_LEFT_ON
    if (event.metaKey) meta |= 0x10000 | 0x20000; // META_ON | META_LEFT_ON
    return meta;
  }

  /** The platform's clipboard modifier: Cmd on macOS, Ctrl elsewhere. */
  function clipboardModifier(event) {
    return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  }

  /** Keycodes currently held down on the device, so focus loss can release them. */
  const held = new Map();

  input.addEventListener('keydown', (event) => {
    if (!inputEnabled() || event.isComposing || event.key === 'Process') return;

    // Cmd/Ctrl+C, X, V: leave to the native copy/cut/paste events below.
    if (clipboardModifier(event) && ['KeyC', 'KeyX', 'KeyV'].includes(event.code)) return;
    // Let VS Code keep its own Cmd shortcuts (palette, tab switching, …).
    if (isMac && event.metaKey) return;

    const keycode = KEYCODES[event.code];
    if (keycode === undefined || MODIFIER_CODES.has(event.code)) return;

    // Text goes through the textarea's input event (IME-safe, layout-aware);
    // keycodes are for keys that aren't text, and for Ctrl/Alt shortcuts
    // like Ctrl+A that Android apps handle as key combos.
    const isText = !NON_TEXT.has(event.code) && !event.ctrlKey && !event.altKey;
    if (isText) return;

    event.preventDefault();
    held.set(event.code, keycode);
    send({
      type: 'key',
      keycode,
      action: 'down',
      repeat: event.repeat ? 1 : 0,
      meta: metaState(event),
    });
  });

  input.addEventListener('keyup', (event) => {
    const keycode = held.get(event.code);
    if (keycode === undefined) return;
    held.delete(event.code);
    event.preventDefault();
    send({ type: 'key', keycode, action: 'up', meta: metaState(event) });
  });

  input.addEventListener('blur', () => {
    // A key released while focus was elsewhere never sends keyup; release it
    // now rather than leave it stuck down on the device.
    for (const keycode of held.values()) send({ type: 'key', keycode, action: 'up' });
    held.clear();
  });

  // Committed text: plain typing, dead keys and IME output all land here.
  input.addEventListener('input', (event) => {
    if (event.isComposing) return; // wait for compositionend
    flushText();
  });
  input.addEventListener('compositionend', () => flushText());

  function flushText() {
    const text = input.value;
    input.value = '';
    if (text && inputEnabled()) send({ type: 'text', text });
  }

  input.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData && event.clipboardData.getData('text/plain');
    if (text && inputEnabled()) send({ type: 'paste', text });
  });
  input.addEventListener('copy', (event) => {
    event.preventDefault();
    if (inputEnabled()) send({ type: 'action', name: 'copy' });
  });
  input.addEventListener('cut', (event) => {
    event.preventDefault();
    if (inputEnabled()) send({ type: 'action', name: 'cut' });
  });

  // ----------------------------------------------------------------- toolbar

  document.querySelectorAll('#keys button[data-keycode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!inputEnabled()) return;
      send({ type: 'key', keycode: Number(button.dataset.keycode), action: 'press' });
      focusInput();
    });
  });

  document.querySelectorAll('#keys button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      // Screenshot/record go through adb and work in screencap mode too.
      if (!button.classList.contains('any-mode') && !inputEnabled()) return;
      send({ type: 'action', name: button.dataset.action });
      focusInput();
    });
  });

  connect();
})();
