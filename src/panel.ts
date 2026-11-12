import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Device,
  findAdb,
  getScreenSize,
  listDevices,
  reconnectNetworkDevice,
} from './adb';
import { Bridge, KIND_AUDIO, KIND_IMAGE, KIND_VIDEO } from './bridge';
import * as control from './control';
import { MediaPacket, ScrcpySession, StreamMeta } from './scrcpy';
import { ScreencapSession } from './screencap';

type Backend = 'scrcpy' | 'screencap';

/** What the webview shows over the canvas. Replayed on (re)connect. */
type ConnectionState = 'connecting' | 'streaming' | 'disconnected';

/** How often to poll adb for the device while disconnected. */
const WATCH_INTERVAL_MS = 2000;

/**
 * Pointer coordinates arrive already in video-frame pixels, stamped with the
 * frame size the webview decoded them against. They are NOT normalised and NOT
 * rescaled here: scrcpy's PositionMapper compares `w`/`h` against the current
 * video size and drops the event on any mismatch, which is exactly how a touch
 * that raced a rotation is meant to be discarded.
 */
interface TouchMessage {
  type: 'touch';
  action: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0..1, from a pen or pressure-sensitive touch. Absent => full pressure. */
  pressure?: number;
  /** 0 = the real pointer, 1 = the mirrored virtual finger of a pinch. */
  finger?: 0 | 1;
}

/**
 * A key event. `action` 'press' sends down+up (toolbar buttons); 'down'/'up'
 * mirror the physical key so holds and auto-repeat behave like a keyboard.
 */
interface KeyMessage {
  type: 'key';
  keycode: number;
  action?: 'press' | 'down' | 'up';
  repeat?: number;
  /** Android KeyEvent meta state bits. */
  meta?: number;
}

interface TextMessage {
  type: 'text';
  text: string;
}

interface ScrollMessage {
  type: 'scroll';
  x: number;
  y: number;
  w: number;
  h: number;
  hscroll: number;
  vscroll: number;
}

/** Webview dropped frames to catch up and needs a fresh key frame. */
interface ResetVideoMessage {
  type: 'resetVideo';
}

/** User pressed Reconnect. */
interface ReconnectMessage {
  type: 'reconnect';
}

/** Toolbar buttons and shortcuts that aren't plain keys. */
interface ActionMessage {
  type: 'action';
  name:
    | 'rotate'
    | 'toggleDisplay'
    | 'backOrScreenOn'
    | 'notifications'
    | 'quickSettings'
    | 'collapsePanels'
    | 'copy'
    | 'cut'
    | 'screenshot'
    | 'record';
}

/** Host clipboard text to put on the device (and paste, from Cmd/Ctrl+V). */
interface PasteMessage {
  type: 'paste';
  text: string;
}

type InboundMessage =
  | TouchMessage
  | KeyMessage
  | TextMessage
  | ScrollMessage
  | ResetVideoMessage
  | ReconnectMessage
  | ActionMessage
  | PasteMessage;

/**
 * One webview + bridge per mirrored device for the life of its tab, wrapping
 * a capture session that can be torn down and restarted underneath it
 * (device unplugged, settings changed, Reconnect pressed) without reloading
 * the page.
 */
export class MirrorPanel {
  private static readonly panels = new Map<string, MirrorPanel>();
  private static lastActive?: MirrorPanel;
  private static readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a mirror opens or closes. */
  static readonly onDidChange = MirrorPanel.changed.event;

  private readonly disposables: vscode.Disposable[] = [];
  private bridge = new Bridge();
  private scrcpy?: ScrcpySession;
  private screencap?: ScreencapSession;
  private disposing?: Promise<void>;
  /**
   * Bumped whenever a session is started or abandoned. Session callbacks
   * capture the value they were created with and ignore themselves once it
   * moves on, so a late event from a dead session can't clobber a live one.
   */
  private generation = 0;
  private restarting?: Promise<void>;
  private watchTimer?: NodeJS.Timeout;
  /** transport_id the current session was started on; see startWatching. */
  private sessionTransport?: string;
  private settingsPromptOpen = false;
  /** Whether we've turned the device's physical display off. */
  private displayOn = true;
  /**
   * Last clipboard text we exchanged with the device, in either direction.
   * Autosync echoes our own SET_CLIPBOARD back; this suppresses the echo.
   */
  private lastClipboard?: string;
  /**
   * Physical display size. Only used to give the screencap canvas a sane
   * aspect before its first PNG lands — touch mapping deliberately does NOT
   * use it, see TouchMessage.
   */
  private screen = { width: 1080, height: 1920 };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private adb: string,
    readonly device: Device,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) MirrorPanel.lastActive = this;
      },
      null,
      this.disposables,
    );
    vscode.workspace.onDidChangeConfiguration(
      (event) => this.onConfigChanged(event),
      null,
      this.disposables,
    );
  }

  /** Every open mirror. */
  static all(): MirrorPanel[] {
    return [...MirrorPanel.panels.values()];
  }

  static forSerial(serial: string): MirrorPanel | undefined {
    return MirrorPanel.panels.get(serial);
  }

  /** The focused mirror, else the most recently focused one still open. */
  static active(): MirrorPanel | undefined {
    const focused = MirrorPanel.all().find((p) => p.panel.active);
    if (focused) return focused;
    const last = MirrorPanel.lastActive;
    return last && !last.disposing ? last : undefined;
  }

  static async show(
    context: vscode.ExtensionContext,
    adb: string,
    device: Device,
    output: vscode.OutputChannel,
  ): Promise<void> {
    // One panel per device: mirroring it again just brings its tab forward.
    const existing = MirrorPanel.panels.get(device.serial);
    if (existing && !existing.disposing) {
      existing.panel.reveal();
      return;
    }

    // Open beside the editor, but stack further mirrors in the same group
    // rather than splitting the window once per device.
    const column = MirrorPanel.active()?.panel.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(
      'deviceMirror',
      device.model ?? device.serial,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
        ],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('device-mobile');

    const instance = new MirrorPanel(panel, context, adb, device, output);
    MirrorPanel.panels.set(device.serial, instance);
    MirrorPanel.lastActive = instance;
    MirrorPanel.changed.fire();
    await instance.start();
  }

  /** Close every mirror; resolves when all adb forwards are removed. */
  static async disposeAll(): Promise<void> {
    await Promise.all(MirrorPanel.all().map((p) => p.dispose()));
  }

  private async start(): Promise<void> {
    const port = await this.bridge.listen();
    this.bridge.onMessage((msg) => this.handleInbound(msg as InboundMessage));
    if (this.disposing) {
      return;
    }
    this.panel.webview.html = this.render(port, this.bridge.token);
    await this.startSession();
  }

  /** Tell the webview whether a screen recording is running for this device. */
  setRecording(startedAt: number | undefined): void {
    this.bridge.sendSticky('recording', {
      type: 'recording',
      active: startedAt !== undefined,
      startedAt,
    });
  }

  // ------------------------------------------------------------ session life

  private async startSession(): Promise<void> {
    const gen = ++this.generation;
    this.setState('connecting');

    const config = vscode.workspace.getConfiguration('deviceMirror');
    const mode = config.get<Backend>('mode', 'scrcpy');

    try {
      this.screen = await getScreenSize(this.adb, this.device.serial);
    } catch (err) {
      this.log(`could not read screen size, assuming 1080x1920: ${err}`);
    }
    this.sessionTransport = await this.currentTransport();

    if (this.disposing || gen !== this.generation) {
      return; // closed or restarted while adb was answering
    }

    // A new server process starts with the display on.
    this.displayOn = true;
    this.bridge.sendSticky('display', { type: 'display', on: true });

    if (mode === 'screencap') {
      this.startScreencap(gen);
    } else {
      await this.startScrcpy(config, gen);
    }
  }

  private startScreencap(gen: number): void {
    const session = new ScreencapSession(this.adb, this.device.serial);
    this.screencap = session;
    session.on('frame', (png: Buffer) => {
      if (gen === this.generation) this.bridge.sendBinary(KIND_IMAGE, 0, png);
    });
    session.on('log', (line: string) => this.log(line));
    session.on('close', () => this.onSessionEnded(gen, 'Lost the device.'));
    this.bridge.sendSticky('audio', { type: 'audio', state: 'off' });
    this.bridge.sendSticky('meta', {
      type: 'meta',
      mode: 'screencap',
      width: this.screen.width,
      height: this.screen.height,
      deviceName: this.device.model ?? this.device.serial,
    });
    this.setState('streaming');
    session.start();
  }

  private async startScrcpy(
    config: vscode.WorkspaceConfiguration,
    gen: number,
  ): Promise<void> {
    const audio = config.get<boolean>('audio', false);
    const session = new ScrcpySession({
      adb: this.adb,
      serial: this.device.serial,
      serverJar: path.join(this.context.extensionPath, 'server', 'scrcpy-server.jar'),
      maxSize: config.get<number>('maxSize', 1024),
      maxFps: config.get<number>('maxFps', 30),
      // H.264 only: VS Code's Electron can decode nothing else through
      // WebCodecs (H.265, AV1 and VP9 all report unsupported), even though
      // ScrcpySession and the device may support them.
      videoCodec: 'h264',
      videoBitRate: config.get<number>('videoBitRate', 0),
      audio,
      stayAwake: config.get<boolean>('stayAwake', false),
    });
    this.scrcpy = session;
    this.bridge.sendSticky('audio', { type: 'audio', state: audio ? 'pending' : 'off' });

    session.on('meta', (meta: StreamMeta) => {
      if (gen !== this.generation) return;
      this.bridge.sendSticky('meta', { type: 'meta', mode: 'scrcpy', ...meta });
      this.setState('streaming');
    });
    session.on('packet', (packet: MediaPacket) => {
      if (gen !== this.generation) return;
      const flags = (packet.isConfig ? 1 : 0) | (packet.isKeyFrame ? 2 : 0);
      this.bridge.sendBinary(KIND_VIDEO, flags, packet.payload);
    });
    session.on('audioMeta', ({ codec }: { codec: string }) => {
      if (gen !== this.generation) return;
      this.bridge.sendSticky('audio', { type: 'audio', state: 'on', codec });
    });
    session.on('audioPacket', (packet: MediaPacket) => {
      if (gen !== this.generation) return;
      this.bridge.sendBinary(KIND_AUDIO, packet.isConfig ? 1 : 0, packet.payload);
    });
    session.on('audioUnavailable', (reason: string) => {
      if (gen !== this.generation) return;
      this.log(`audio unavailable: ${reason}`);
      this.bridge.sendSticky('audio', { type: 'audio', state: 'unavailable', reason });
    });
    session.on('clipboard', (text: string) => {
      if (gen !== this.generation || text === this.lastClipboard) return;
      this.lastClipboard = text;
      void vscode.env.clipboard.writeText(text);
    });
    session.on('log', (line: string) => this.log(line));
    session.on('close', () => this.onSessionEnded(gen, 'Device stream ended.'));

    try {
      await session.start();
    } catch (err) {
      if (this.disposing || gen !== this.generation) {
        return; // closed or restarted mid-startup; not an error
      }
      this.log(`${err}`);
      void vscode.window.showErrorMessage(`Device Mirror: ${err}`);
      this.onSessionEnded(gen, String(err));
    }
  }

  /**
   * The stream is gone. Show Reconnect, and watch adb so that a device that
   * drops off and comes back (cable wiggle, Wi-Fi blip, reboot) is picked up
   * automatically.
   */
  private onSessionEnded(gen: number, message: string): void {
    if (this.disposing || gen !== this.generation) {
      return;
    }
    this.generation++; // nothing from the dead session may reach the webview now
    this.log(`session ended: ${message}`);
    void this.stopSession();
    this.setState('disconnected', message);
    this.startWatching();
  }

  /**
   * Auto-restart only once the device has actually re-attached: either we saw
   * it missing, or adb reports a different transport_id than the session
   * started on. The second catches drops shorter than one poll (a cable
   * wiggle, `adb reconnect`), which polling alone misses.
   *
   * If the stream died while the device stayed attached on the same
   * transport, the server itself is failing; reconnecting immediately would
   * just loop, so that case waits for the user to press Reconnect.
   */
  private startWatching(): void {
    this.stopWatching();
    const serial = this.device.serial;
    const startedOn = this.sessionTransport;
    let sawGone = false;
    let busy = false;

    this.watchTimer = setInterval(async () => {
      if (busy || this.disposing || this.restarting) return;
      busy = true;
      try {
        let device: Device | undefined;
        try {
          device = (await listDevices(this.adb)).find(
            (d) => d.serial === serial && d.state === 'device',
          );
        } catch {
          // adb itself unhappy (e.g. server restarting); treat as not ready.
        }
        if (!device) {
          sawGone = true;
          await reconnectNetworkDevice(this.adb, serial);
        } else if (sawGone || (startedOn && device.transportId !== startedOn)) {
          this.log('device re-attached; reconnecting');
          void this.restart();
        }
      } finally {
        busy = false;
      }
    }, WATCH_INTERVAL_MS);
  }

  private async currentTransport(): Promise<string | undefined> {
    try {
      const devices = await listDevices(this.adb);
      return devices.find((d) => d.serial === this.device.serial)?.transportId;
    } catch {
      return undefined;
    }
  }

  private stopWatching(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  /** Tear down the current capture session; resolves once its forward is gone. */
  private stopSession(): Promise<void> {
    this.screencap?.dispose();
    this.screencap = undefined;
    const scrcpy = this.scrcpy;
    this.scrcpy = undefined;
    return scrcpy?.dispose() ?? Promise.resolve();
  }

  /** Stop whatever is running and start fresh with current settings. */
  restart(): Promise<void> {
    if (this.disposing) {
      return Promise.resolve();
    }
    if (!this.restarting) {
      this.restarting = (async () => {
        this.stopWatching();
        this.generation++;
        await this.stopSession();
        this.adb = findAdb(); // adbPath may be what changed
        await this.startSession();
      })().finally(() => {
        this.restarting = undefined;
      });
    }
    return this.restarting;
  }

  private onConfigChanged(event: vscode.ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('deviceMirror') || this.settingsPromptOpen) {
      return;
    }
    // With several mirrors open, ask once rather than once per panel.
    const first = MirrorPanel.all().find((p) => !p.disposing);
    if (first !== this) {
      return;
    }
    // Ask rather than restart outright: a restart drops whatever the user is
    // in the middle of on the device, and several settings often change at once.
    this.settingsPromptOpen = true;
    const count = MirrorPanel.all().length;
    void vscode.window
      .showInformationMessage(
        count > 1
          ? `Device Mirror settings changed. Restart all ${count} mirrors to apply them?`
          : 'Device Mirror settings changed. Restart mirroring to apply them?',
        'Restart',
      )
      .then((choice) => {
        this.settingsPromptOpen = false;
        if (choice === 'Restart') {
          for (const p of MirrorPanel.all()) void p.restart();
        }
      });
  }

  private setState(state: ConnectionState, message?: string): void {
    this.bridge.sendSticky('state', { type: 'state', state, message });
  }

  // ------------------------------------------------------------------- input

  private handleInbound(msg: InboundMessage): void {
    if (msg.type === 'reconnect') {
      this.log('reconnect requested');
      void this.restart();
      return;
    }
    // Capture works in either backend; it goes through adb, not scrcpy.
    if (msg.type === 'action' && (msg.name === 'screenshot' || msg.name === 'record')) {
      void vscode.commands.executeCommand(
        msg.name === 'screenshot' ? 'deviceMirror.screenshot' : 'deviceMirror.toggleRecording',
        { device: this.device },
      );
      return;
    }

    const scrcpy = this.scrcpy;
    if (!scrcpy) {
      return; // screencap mode is view-only, or nothing is running
    }

    switch (msg.type) {
      case 'touch':
        scrcpy.sendControl(
          control.touchEvent({
            action: msg.action,
            x: msg.x,
            y: msg.y,
            screenWidth: msg.w,
            screenHeight: msg.h,
            pointerId:
              msg.finger === 1
                ? control.POINTER_ID_VIRTUAL_FINGER
                : control.POINTER_ID_GENERIC_FINGER,
            pressure:
              typeof msg.pressure === 'number' && Number.isFinite(msg.pressure)
                ? Math.min(1, Math.max(0, msg.pressure))
                : undefined,
          }),
        );
        break;
      case 'scroll':
        scrcpy.sendControl(
          control.scrollEvent({
            x: msg.x,
            y: msg.y,
            screenWidth: msg.w,
            screenHeight: msg.h,
            hscroll: msg.hscroll,
            vscroll: msg.vscroll,
          }),
        );
        break;
      case 'key': {
        const meta = Number.isInteger(msg.meta) ? msg.meta! : 0;
        const repeat = Number.isInteger(msg.repeat) ? msg.repeat! : 0;
        if (msg.action === 'down') {
          scrcpy.sendControl(control.keycodeEvent(msg.keycode, control.KEY_ACTION_DOWN, repeat, meta));
        } else if (msg.action === 'up') {
          scrcpy.sendControl(control.keycodeEvent(msg.keycode, control.KEY_ACTION_UP, 0, meta));
        } else {
          scrcpy.sendControl(control.keyPress(msg.keycode));
        }
        break;
      }
      case 'text':
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          scrcpy.sendControl(control.injectText(msg.text));
        }
        break;
      case 'paste':
        if (typeof msg.text === 'string') {
          // Set the device clipboard and paste it, the way scrcpy does for
          // MOD+v. Typing it with INJECT_TEXT would mangle non-ASCII text and
          // be slow for anything long.
          this.lastClipboard = msg.text;
          scrcpy.sendControl(control.setClipboard(msg.text, true));
        }
        break;
      case 'resetVideo':
        this.log('decoder fell behind; dropped frames and requested a key frame');
        scrcpy.sendControl(control.resetVideo());
        break;
      case 'action':
        this.handleAction(scrcpy, msg.name);
        break;
    }
  }

  private handleAction(scrcpy: ScrcpySession, name: ActionMessage['name']): void {
    switch (name) {
      case 'rotate':
        scrcpy.sendControl(control.rotateDevice());
        break;
      case 'toggleDisplay':
        this.displayOn = !this.displayOn;
        scrcpy.sendControl(control.setDisplayPower(this.displayOn));
        this.bridge.sendSticky('display', { type: 'display', on: this.displayOn });
        break;
      case 'backOrScreenOn':
        scrcpy.sendControl(
          Buffer.concat([
            control.backOrScreenOn(control.KEY_ACTION_DOWN),
            control.backOrScreenOn(control.KEY_ACTION_UP),
          ]),
        );
        break;
      case 'notifications':
        scrcpy.sendControl(control.expandNotificationPanel());
        break;
      case 'quickSettings':
        scrcpy.sendControl(control.expandSettingsPanel());
        break;
      case 'collapsePanels':
        scrcpy.sendControl(control.collapsePanels());
        break;
      case 'copy':
      case 'cut':
        // The device copies its selection, then autosync reports the new
        // clipboard back to us as a 'clipboard' event.
        scrcpy.sendControl(
          control.getClipboard(name === 'cut' ? control.COPY_KEY_CUT : control.COPY_KEY_COPY),
        );
        break;
    }
  }

  private render(port: number, token: string): string {
    const webview = this.panel.webview;
    const asUri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.file(path.join(this.context.extensionPath, 'media', file)),
      );
    const nonce = randomNonce();

    // Webviews enforce a CSP: without connect-src for our loopback socket the
    // bridge silently fails to connect, and without the nonce the script is
    // blocked outright.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ws://127.0.0.1:${port}`,
    ].join('; ');

    const isMac = process.platform === 'darwin';
    const pinchHint = 'Alt+drag: pinch/rotate around the centre';
    const keys = control;

    // The backend is NOT baked into the page: a restart can switch between
    // scrcpy and screencap without reloading, so the webview learns the mode
    // from each 'meta' message instead.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${asUri('style.css')}">
<title>Device Mirror</title>
</head>
<body data-port="${port}" data-token="${token}" data-mac="${isMac}" data-serial="${escapeAttr(this.device.serial)}">
  <div id="stage">
    <canvas id="screen" tabindex="-1" title="Right-click: Back · Middle-click: Home · ${pinchHint}"></canvas>
    <textarea id="input" aria-label="Device keyboard input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
    <div id="status" role="status">
      <span id="status-text">Connecting…</span>
      <button id="reconnect" hidden>Reconnect</button>
    </div>
    <div id="badges">
      <span id="rec-badge" hidden>&#9679; REC <span id="rec-time">0:00</span></span>
      <button id="audio-badge" hidden title="Click to enable device audio">&#128263; Click to enable audio</button>
    </div>
  </div>
  <nav id="keys" hidden>
    <button data-keycode="${keys.KEYCODE_APP_SWITCH}" title="Recents">&#9723;</button>
    <button data-keycode="${keys.KEYCODE_HOME}" title="Home">&#9675;</button>
    <button data-keycode="${keys.KEYCODE_BACK}" title="Back">&#9665;</button>
    <span class="sep"></span>
    <button data-action="notifications" title="Notifications (swipe down)">&#8615;</button>
    <button data-action="rotate" title="Rotate device">&#10227;</button>
    <button data-action="toggleDisplay" id="display-btn" title="Turn device screen off (keeps mirroring)">&#9680;</button>
    <span class="spacer"></span>
    <button data-action="screenshot" class="any-mode" title="Save screenshot">&#9113;</button>
    <button data-action="record" id="record-btn" class="any-mode" title="Start screen recording">&#9210;</button>
    <button id="mute-btn" hidden title="Mute device audio">&#128266;</button>
    <span class="sep"></span>
    <button data-keycode="${keys.KEYCODE_VOLUME_DOWN}" title="Volume down">&minus;</button>
    <button data-keycode="${keys.KEYCODE_VOLUME_UP}" title="Volume up">&plus;</button>
    <button data-keycode="${keys.KEYCODE_POWER}" title="Power">&#9211;</button>
  </nav>
  <script nonce="${nonce}" src="${asUri('main.js')}"></script>
</body>
</html>`;
  }

  private log(line: string): void {
    this.output.appendLine(`[${this.device.serial}] ${line.trimEnd()}`);
  }

  /**
   * Idempotent: closing the tab, the Stop command, opening a new mirror and
   * deactivate() can all land here, sometimes re-entrantly (panel.dispose()
   * fires onDidDispose). Resolves once the adb forward has been removed.
   */
  dispose(): Promise<void> {
    if (this.disposing) {
      return this.disposing;
    }
    // Set before anything else so re-entrant calls short-circuit.
    this.generation++;
    this.stopWatching();
    this.disposing = this.stopSession();

    if (MirrorPanel.panels.get(this.device.serial) === this) {
      MirrorPanel.panels.delete(this.device.serial);
    }
    if (MirrorPanel.lastActive === this) {
      MirrorPanel.lastActive = undefined;
    }
    this.bridge.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
    MirrorPanel.changed.fire();
    return this.disposing;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function randomNonce(): string {
  return randomBytes(18).toString('base64');
}
