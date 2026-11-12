import { randomBytes, timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

export const KIND_VIDEO = 0x01;
export const KIND_IMAGE = 0x02;
export const KIND_AUDIO = 0x03;

/**
 * Frames go webview-ward over a loopback WebSocket rather than postMessage.
 * postMessage structured-clones every frame through the extension RPC layer,
 * which is measurable overhead at 30fps; a raw binary ws message is not.
 *
 * Binding to 127.0.0.1 is NOT access control: browsers let any web page open a
 * WebSocket to loopback, and anything on the socket can watch the screen and
 * inject input. So every connection must present a per-session secret that
 * only the webview knows, come from a VS Code webview origin, and be the only
 * client.
 */
export class Bridge {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private onTextMessage?: (msg: unknown) => void;
  /**
   * Latest message per key, replayed to a client when it connects. The host
   * often knows the stream geometry or connection state before the webview
   * has finished loading; without replay those messages are simply lost.
   */
  private sticky = new Map<string, string>();

  /** Hex secret the webview appends as `?token=`. */
  readonly token = randomBytes(32).toString('hex');

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Port 0 => the OS picks a free one, so two windows never collide.
      this.wss = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        // Inbound traffic is small JSON control messages; refuse anything big.
        maxPayload: 64 * 1024,
        verifyClient: (info: { origin: string; req: IncomingMessage }) =>
          this.isAuthorised(info.origin, info.req),
      });
      this.wss.on('listening', () => {
        const address = this.wss!.address() as AddressInfo;
        resolve(address.port);
      });
      this.wss.on('error', reject);
      this.wss.on('connection', (socket) => {
        // verifyClient's size check can race two concurrent handshakes.
        if (this.clients.size > 0) {
          socket.terminate();
          return;
        }
        this.clients.add(socket);
        for (const text of this.sticky.values()) {
          socket.send(text);
        }
        socket.on('close', () => this.clients.delete(socket));
        socket.on('message', (data, isBinary) => {
          if (isBinary) return;
          try {
            this.onTextMessage?.(JSON.parse(data.toString()));
          } catch {
            // Ignore malformed input from the webview.
          }
        });
      });
    });
  }

  private isAuthorised(origin: string | undefined, req: IncomingMessage): boolean {
    // There is exactly one webview per bridge; a second client is never legit.
    if (this.clients.size > 0) {
      return false;
    }
    if (!origin || !origin.startsWith('vscode-webview://')) {
      return false;
    }
    const presented = new URL(req.url ?? '/', 'ws://127.0.0.1').searchParams.get('token');
    if (!presented) {
      return false;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  onMessage(handler: (msg: unknown) => void): void {
    this.onTextMessage = handler;
  }

  /** Prefix a one-byte kind + one-byte flags so the webview can demux. */
  sendBinary(kind: number, flags: number, payload: Buffer): void {
    const framed = Buffer.alloc(2 + payload.length);
    framed.writeUInt8(kind, 0);
    framed.writeUInt8(flags, 1);
    payload.copy(framed, 2);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(framed, { binary: true });
      }
    }
  }

  /** Send now, and replay to any client that connects later. */
  sendSticky(key: string, message: unknown): void {
    this.sticky.set(key, JSON.stringify(message));
    this.sendJson(message);
  }

  sendJson(message: unknown): void {
    const text = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    }
  }

  dispose(): void {
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    this.wss?.close();
  }
}
