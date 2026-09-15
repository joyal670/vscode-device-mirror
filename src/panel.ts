import * as path from 'path';
import * as vscode from 'vscode';
import { Device, getScreenSize } from './adb';
import { Bridge, KIND_IMAGE, KIND_VIDEO } from './bridge';
import * as control from './control';
import { ScrcpySession, StreamMeta, VideoPacket } from './scrcpy';
import { ScreencapSession } from './screencap';

type Backend = 'scrcpy' | 'screencap';

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

type InboundMessage = TouchMessage | KeyMessage | TextMessage | ScrollMessage;

export class MirrorPanel {
  private static current?: MirrorPanel;

  private readonly disposables: vscode.Disposable[] = [];
  private bridge = new Bridge();
  private scrcpy?: ScrcpySession;
  private screencap?: ScreencapSession;
  /**
   * Physical display size. Only used to give the screencap canvas a sane
   * aspect before its first PNG lands — touch mapping deliberately does NOT
   * use it, see TouchMessage.
   */
  private screen = { width: 1080, height: 1920 };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly adb: string,
    private readonly device: Device,
    private readonly output: vscode.OutputChannel,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static async show(
    context: vscode.ExtensionContext,
    adb: string,
    device: Device,
    output: vscode.OutputChannel,
  ): Promise<void> {
    MirrorPanel.current?.dispose();

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
    const config = vscode.workspace.getConfiguration('deviceMirror');
    const mode = config.get<Backend>('mode', 'scrcpy');

    const port = await this.bridge.listen();
    this.bridge.onMessage((msg) => this.handleInbound(msg as InboundMessage));

    try {
      this.screen = await getScreenSize(this.adb, this.device.serial);
    } catch (err) {
      this.log(`could not read screen size, assuming 1080x1920: ${err}`);
    }

    this.panel.webview.html = this.render(port, mode);

    if (mode === 'screencap') {
      await this.startScreencap();
    } else {
      await this.startScrcpy(config);
    }
  }

  private async startScreencap(): Promise<void> {
    const session = new ScreencapSession(this.adb, this.device.serial);
    this.screencap = session;
    session.on('frame', (png: Buffer) =>
      this.bridge.sendBinary(KIND_IMAGE, 0, png),
    );
    session.on('log', (line: string) => this.log(line));
    session.start();
    this.bridge.sendJson({
      type: 'meta',
      mode: 'screencap',
      width: this.screen.width,
      height: this.screen.height,
      deviceName: this.device.model ?? this.device.serial,
    });
  }

  private async startScrcpy(config: vscode.WorkspaceConfiguration): Promise<void> {
    const session = new ScrcpySession({
      adb: this.adb,
      serial: this.device.serial,
      serverJar: path.join(this.context.extensionPath, 'server', 'scrcpy-server.jar'),
      version: config.get<string>('scrcpyVersion', '3.1'),
      maxSize: config.get<number>('maxSize', 1024),
      maxFps: config.get<number>('maxFps', 30),
      // Random-ish port so two panels don't fight over one forward rule.
      port: 27183 + Math.floor(Math.random() * 100),
    });
    this.scrcpy = session;

    session.on('meta', (meta: StreamMeta) => {
      this.bridge.sendJson({ type: 'meta', mode: 'scrcpy', ...meta });
    });
    session.on('packet', (packet: VideoPacket) => {
      const flags = (packet.isConfig ? 1 : 0) | (packet.isKeyFrame ? 2 : 0);
      this.bridge.sendBinary(KIND_VIDEO, flags, packet.payload);
    });
    session.on('log', (line: string) => this.log(line));
    session.on('close', () => this.bridge.sendJson({ type: 'closed' }));

    try {
      await session.start();
    } catch (err) {
      this.log(`${err}`);
      void vscode.window.showErrorMessage(`Device Mirror: ${err}`);
      this.bridge.sendJson({ type: 'error', message: String(err) });
    }
  }

  private handleInbound(msg: InboundMessage): void {
    if (!this.scrcpy) {
      return; // screencap mode is view-only
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
    }
  }

  private render(port: number, mode: Backend): string {
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${asUri('style.css')}">
<title>Device Mirror</title>
</head>
<body data-port="${port}" data-mode="${mode}">
  <div id="stage">
    <canvas id="screen" tabindex="0"></canvas>
    <div id="status">Connecting…</div>
  </div>
  <nav id="keys">
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

  dispose(): void {
    if (MirrorPanel.current === this) {
      MirrorPanel.current = undefined;
    }
    this.screencap?.dispose();
    void this.scrcpy?.dispose();
    this.bridge.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
  }
}

function randomNonce(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}
