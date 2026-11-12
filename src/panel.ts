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
import { Bridge, KIND_IMAGE, KIND_VIDEO } from './bridge';
import * as control from './control';
import { ScrcpySession, StreamMeta, VideoPacket } from './scrcpy';
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
}

interface KeyMessage {
  type: 'key';
  keycode: number;
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

type InboundMessage =
  | TouchMessage
  | KeyMessage
  | TextMessage
  | ScrollMessage
  | ResetVideoMessage
  | ReconnectMessage;

/**
 * One webview + bridge for the life of the tab, wrapping a capture session
 * that can be torn down and restarted underneath it (device unplugged,
 * settings changed, Reconnect pressed) without reloading the page.
 */
export class MirrorPanel {
  static current?: MirrorPanel;

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
    private readonly device: Device,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (event) => this.onConfigChanged(event),
      null,
      this.disposables,
    );
  }

  static async show(
    context: vscode.ExtensionContext,
    adb: string,
    device: Device,
    output: vscode.OutputChannel,
  ): Promise<void> {
    // Await so the old session's adb forward is gone before the new one starts.
    await MirrorPanel.current?.dispose();

    const panel = vscode.window.createWebviewPanel(
      'deviceMirror',
      device.model ?? device.serial,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'media')),
        ],
      },
    );

    const instance = new MirrorPanel(panel, context, adb, device, output);
    MirrorPanel.current = instance;
    await instance.start();
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
    const session = new ScrcpySession({
      adb: this.adb,
      serial: this.device.serial,
      serverJar: path.join(this.context.extensionPath, 'server', 'scrcpy-server.jar'),
      version: config.get<string>('scrcpyVersion', '3.1'),
      maxSize: config.get<number>('maxSize', 1024),
      maxFps: config.get<number>('maxFps', 30),
    });
    this.scrcpy = session;

    session.on('meta', (meta: StreamMeta) => {
      if (gen !== this.generation) return;
      this.bridge.sendSticky('meta', { type: 'meta', mode: 'scrcpy', ...meta });
      this.setState('streaming');
    });
    session.on('packet', (packet: VideoPacket) => {
      if (gen !== this.generation) return;
      const flags = (packet.isConfig ? 1 : 0) | (packet.isKeyFrame ? 2 : 0);
      this.bridge.sendBinary(KIND_VIDEO, flags, packet.payload);
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
    // Ask rather than restart outright: a restart drops whatever the user is
    // in the middle of on the device, and several settings often change at once.
    this.settingsPromptOpen = true;
    void vscode.window
      .showInformationMessage(
        'Device Mirror settings changed. Restart mirroring to apply them?',
        'Restart',
      )
      .then((choice) => {
        this.settingsPromptOpen = false;
        if (choice === 'Restart') {
          void this.restart();
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

    if (!this.scrcpy) {
      return; // screencap mode is view-only, or nothing is running
    }

    switch (msg.type) {
      case 'touch':
        this.scrcpy.sendControl(
          control.touchEvent({
            action: msg.action,
            x: msg.x,
            y: msg.y,
            screenWidth: msg.w,
            screenHeight: msg.h,
            pressure:
              typeof msg.pressure === 'number' && Number.isFinite(msg.pressure)
                ? Math.min(1, Math.max(0, msg.pressure))
                : undefined,
          }),
        );
        break;
      case 'scroll':
        this.scrcpy.sendControl(
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
      case 'key':
        this.scrcpy.sendControl(control.keyPress(msg.keycode));
        break;
      case 'text':
        this.scrcpy.sendControl(control.injectText(msg.text));
        break;
      case 'resetVideo':
        this.log('decoder fell behind; dropped frames and requested a key frame');
        this.scrcpy.sendControl(control.resetVideo());
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
<body data-port="${port}" data-token="${token}">
  <div id="stage">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="status" role="status">
      <span id="status-text">Connecting…</span>
      <button id="reconnect" hidden>Reconnect</button>
    </div>
  </div>
  <nav id="keys" hidden>
    <button data-keycode="${control.KEYCODE_APP_SWITCH}" title="Recents">&#9723;</button>
    <button data-keycode="${control.KEYCODE_HOME}" title="Home">&#9675;</button>
    <button data-keycode="${control.KEYCODE_BACK}" title="Back">&#9665;</button>
    <span class="spacer"></span>
    <button data-keycode="${control.KEYCODE_VOLUME_DOWN}" title="Volume down">&minus;</button>
    <button data-keycode="${control.KEYCODE_VOLUME_UP}" title="Volume up">&plus;</button>
    <button data-keycode="${control.KEYCODE_POWER}" title="Power">&#9211;</button>
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

    if (MirrorPanel.current === this) {
      MirrorPanel.current = undefined;
    }
    this.bridge.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
    return this.disposing;
  }
}

function randomNonce(): string {
  return randomBytes(18).toString('base64');
}
