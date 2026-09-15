(function () {
  'use strict';

  const KIND_VIDEO = 0x01;
  const KIND_IMAGE = 0x02;

  const FLAG_CONFIG = 1;
  const FLAG_KEY = 2;

  const ACTION_DOWN = 0;
  const ACTION_UP = 1;
  const ACTION_MOVE = 2;

  const canvas = document.getElementById('screen');
  const statusEl = document.getElementById('status');
  const ctx = canvas.getContext('2d');

  const port = document.body.dataset.port;
  const mode = document.body.dataset.mode;

  let decoder = null;
  let pendingConfig = null; // held SPS/PPS, prepended to the next key frame
  let socket = null;

  /**
   * The coordinate space every pointer event is reported in. This is the
   * ENCODED VIDEO size (after max_size downscaling), not the physical display
   * size — scrcpy's PositionMapper rejects any event whose stamped size does
   * not match the current video size exactly. It changes on rotation, so it is
   * re-read from each decoded frame rather than fetched once at startup.
   */
  let videoSize = { width: 0, height: 0 };
  let cancelGesture = () => {};

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

  function setStatus(text) {
    if (!text) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  // ---------------------------------------------------------------- transport

  function connect() {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => setStatus('Waiting for first frame…');
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
      }
    };
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function handleJson(message) {
    if (message.type === 'meta') {
      setVideoSize(message.width, message.height);
      setStatus('Waiting for first frame…');
    } else if (message.type === 'error') {
      setStatus(message.message);
    } else if (message.type === 'closed') {
      setStatus('Device stream ended.');
    }
  }

  // -------------------------------------------------------------- tier 0 path

  async function handleImage(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    setVideoSize(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    setStatus('');
  }

  // -------------------------------------------------------------- tier 1 path

  /** Walk an Annex B buffer and return the first NAL of the given type. */
  function findNal(bytes, wantedType) {
    for (let i = 0; i + 4 < bytes.length; i++) {
      const isStart3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
      const isStart4 =
        bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
      if (!isStart3 && !isStart4) continue;
      const offset = i + (isStart4 ? 4 : 3);
      if ((bytes[offset] & 0x1f) === wantedType) {
        return bytes.subarray(offset);
      }
    }
    return null;
  }

  function configureFromSps(configBytes) {
    const sps = findNal(configBytes, 7);
    // avc1.<profile_idc><constraint_flags><level_idc>, each as two hex digits.
    const codec = sps
      ? 'avc1.' +
        [sps[1], sps[2], sps[3]]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : 'avc1.42E01E';

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
        setStatus('');
      },
      error: (err) => setStatus(`Decoder error: ${err.message}`),
    });

    // No `description` => the decoder treats the bitstream as Annex B, so we
    // can feed scrcpy's output straight through without muxing to fMP4.
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  function handleVideoPacket(flags, payload) {
    const isConfig = (flags & FLAG_CONFIG) !== 0;
    const isKey = (flags & FLAG_KEY) !== 0;

    if (isConfig) {
      pendingConfig = payload.slice();
      configureFromSps(pendingConfig);
      return;
    }

    if (!decoder || decoder.state !== 'configured') {
      return; // nothing decodable until the config packet has arrived
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

  // ------------------------------------------------------------------- input

  /**
   * Map a DOM event to a point in the current video frame. Returns the size it
   * was measured against so the host can stamp it on the wire — if a rotation
   * lands between here and the device, the mismatch makes the server discard
   * the event instead of applying it to the wrong geometry.
   */
  let lastFraction = { fx: 0, fy: 0 };

  function toVideoPoint(event) {
    const rect = canvas.getBoundingClientRect();
    const fx = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    const fy = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    lastFraction = {
      fx: Math.min(1, Math.max(0, fx)),
      fy: Math.min(1, Math.max(0, fy)),
    };
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

  if (mode === 'scrcpy') {
    let down = false;

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
      send({ type: 'touch', action: ACTION_UP, ...pointInCurrentFrame(lastFraction) });
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (!videoSize.width) return; // no frame decoded yet, nothing to aim at
      canvas.setPointerCapture(event.pointerId);
      canvas.focus();
      down = true;
      send({ type: 'touch', action: ACTION_DOWN, ...toVideoPoint(event) });
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!down) return;
      send({ type: 'touch', action: ACTION_MOVE, ...toVideoPoint(event) });
    });

    const release = (event) => {
      if (!down) return;
      down = false;
      send({ type: 'touch', action: ACTION_UP, ...toVideoPoint(event) });
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (!videoSize.width) return;
        send({
          type: 'scroll',
          ...toVideoPoint(event),
          hscroll: -event.deltaX / 200,
          vscroll: -event.deltaY / 200,
        });
      },
      { passive: false },
    );

    canvas.addEventListener('keydown', (event) => {
      // Printable characters go through INJECT_TEXT; everything else would
      // need an Android keycode map, which is deliberately left as an exercise.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        send({ type: 'text', text: event.key });
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        send({ type: 'key', keycode: 67 }); // KEYCODE_DEL
      } else if (event.key === 'Enter') {
        event.preventDefault();
        send({ type: 'key', keycode: 66 }); // KEYCODE_ENTER
      }
    });

    document.querySelectorAll('#keys button').forEach((button) => {
      button.addEventListener('click', () => {
        send({ type: 'key', keycode: Number(button.dataset.keycode) });
      });
    });
  } else {
    document.getElementById('keys').hidden = true;
  }

  connect();
})();
