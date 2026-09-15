import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

export const KIND_VIDEO = 0x01;
export const KIND_IMAGE = 0x02;

/**
 * Frames go webview-ward over a loopback WebSocket rather than postMessage.
 * postMessage structured-clones every frame through the extension RPC layer,
 * which is measurable overhead at 30fps; a raw binary ws message is not.
 */
export class Bridge {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private onTextMessage?: (msg: unknown) => void;

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      // Port 0 => the OS picks a free one, so two windows never collide.
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      this.wss.on('listening', () => {
        const address = this.wss!.address() as AddressInfo;
        resolve(address.port);
      });
      this.wss.on('error', reject);
      this.wss.on('connection', (socket) => {
        this.clients.add(socket);
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
