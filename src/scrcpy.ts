import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as net from 'net';
import { adbExec } from './adb';

export interface VideoPacket {
  isConfig: boolean;
  isKeyFrame: boolean;
  payload: Buffer;
}

export interface StreamMeta {
  deviceName: string;
  width: number;
  height: number;
}

export interface ScrcpyOptions {
  adb: string;
  serial: string;
  serverJar: string;
  version: string;
  maxSize: number;
  maxFps: number;
  port: number;
  scid?: string;
  /** 'debug' surfaces PositionMapper's rejection of mis-sized input events. */
  logLevel?: 'verbose' | 'debug' | 'info' | 'warn' | 'error';
}

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';

/**
 * Owns one scrcpy server process and its two sockets.
 *
 * Emits:
 *   'meta'   (StreamMeta)   once, after the stream header is parsed
 *   'packet' (VideoPacket)  per encoded frame
 *   'log'    (string)       server stdout/stderr
 *   'close'  ()             server or socket went away
 */
export class ScrcpySession extends EventEmitter {
  private proc?: ChildProcess;
  private videoSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private stage: 'dummy' | 'deviceMeta' | 'codecMeta' | 'packets' = 'dummy';
  private disposed = false;

  constructor(private readonly opts: ScrcpyOptions) {
    super();
  }

  async start(): Promise<void> {
    const { adb, serial, serverJar, version, maxSize, maxFps, port } = this.opts;
    // A fixed scid lets a stale socket from a previous run be silently
    // inherited, so generate one per session the way the scrcpy client does.
    const scid =
      this.opts.scid ??
      Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');

    if (!existsSync(serverJar)) {
      throw new Error(
        `scrcpy-server.jar not found at ${serverJar}. See server/README.md for how to fetch it.`,
      );
    }

    await adbExec(adb, ['-s', serial, 'push', serverJar, REMOTE_JAR]);
    await adbExec(adb, [
      '-s', serial, 'forward', `tcp:${port}`, `localabstract:scrcpy_${scid}`,
    ]);

    // Arg format is version-specific. These are scrcpy 2.x/3.x key=value args.
    this.proc = spawn(adb, [
      '-s', serial, 'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', version,
      `scid=${scid}`,
      `log_level=${this.opts.logLevel ?? 'info'}`,
      'tunnel_forward=true',
      'audio=false',
      'control=true',
      'cleanup=true',
      'video_codec=h264',
      `max_size=${maxSize}`,
      `max_fps=${maxFps}`,
      'send_frame_meta=true',
      'send_device_meta=true',
      'send_dummy_byte=true',
    ]);

    this.proc.stdout?.on('data', (d: Buffer) => this.emit('log', d.toString()));
    this.proc.stderr?.on('data', (d: Buffer) => this.emit('log', d.toString()));
    this.proc.on('close', () => this.emit('close'));

    // `adb forward` to a dead localabstract socket still ACCEPTS the TCP
    // connection — adb takes it, fails to open the remote end, then closes. So
    // waiting for 'connect' alone can hand back a corpse that silently yields
    // zero frames. Wait for the handshake byte instead.
    const { socket, initial } = await connectVideoWithRetry(port);
    this.videoSocket = socket;
    this.controlSocket = await connectWithRetry(port);

    this.videoSocket.on('data', (chunk) => this.consume(chunk));
    this.consume(initial); // the bytes already read during the handshake
    this.videoSocket.on('close', () => this.emit('close'));
    this.videoSocket.on('error', (err) => this.emit('log', `video socket: ${err}`));
    this.controlSocket.on('error', (err) => this.emit('log', `control socket: ${err}`));
  }

  sendControl(message: Buffer): void {
    this.controlSocket?.write(message);
  }

  /**
   * Stream layout (with send_dummy_byte + send_device_meta + send_frame_meta):
   *   [1]  dummy 0x00            <- only on the first socket; drop it or every
   *   [64] device name, NUL-pad     subsequent offset is wrong
   *   [12] codec id | width | height
   *   then repeating:
   *   [8]  pts (bit63 = config packet, bit62 = key frame)
   *   [4]  payload length
   *   [N]  H.264 Annex B payload
   */
  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.stage === 'dummy') {
        if (this.buffer.length < 1) return;
        this.buffer = this.buffer.subarray(1);
        this.stage = 'deviceMeta';
        continue;
      }

      if (this.stage === 'deviceMeta') {
        if (this.buffer.length < 64) return;
        this.deviceName = this.buffer
          .subarray(0, 64)
          .toString('utf8')
          .replace(/\0.*$/, '');
        this.buffer = this.buffer.subarray(64);
        this.stage = 'codecMeta';
        continue;
      }

      if (this.stage === 'codecMeta') {
        if (this.buffer.length < 12) return;
        const width = this.buffer.readUInt32BE(4);
        const height = this.buffer.readUInt32BE(8);
        this.buffer = this.buffer.subarray(12);
        this.stage = 'packets';
        this.emit('meta', {
          deviceName: this.deviceName ?? 'device',
          width,
          height,
        } satisfies StreamMeta);
        continue;
      }

      if (this.buffer.length < 12) return;
      const length = this.buffer.readUInt32BE(8);
      if (this.buffer.length < 12 + length) return;

      const pts = this.buffer.readBigUInt64BE(0);
      this.emit('packet', {
        isConfig: (pts & (1n << 63n)) !== 0n,
        isKeyFrame: (pts & (1n << 62n)) !== 0n,
        payload: Buffer.from(this.buffer.subarray(12, 12 + length)),
      } satisfies VideoPacket);
      this.buffer = this.buffer.subarray(12 + length);
    }
  }

  private deviceName?: string;

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.proc?.kill();

    // Leaking a forward per reload is the classic way to end up with a
    // hundred dead tcp: rules, so always remove it.
    try {
      await adbExec(this.opts.adb, [
        '-s', this.opts.serial, 'forward', '--remove', `tcp:${this.opts.port}`,
      ]);
    } catch {
      // The device may already be gone; nothing useful to do.
    }
  }
}

/**
 * Connect and wait for the server's first byte, retrying if the socket dies or
 * stays silent. Resolves with the bytes already read so the caller can feed
 * them back into the parser.
 */
function connectVideoWithRetry(
  port: number,
  attempts = 40,
): Promise<{ socket: net.Socket; initial: Buffer }> {
  return new Promise((resolve, reject) => {
    const attempt = (remaining: number) => {
      const socket = net.connect(port, '127.0.0.1');
      let settled = false;

      const retry = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        if (remaining <= 0) {
          reject(
            err ??
              new Error(
                'scrcpy server accepted a connection but never sent the handshake byte',
              ),
          );
          return;
        }
        setTimeout(() => attempt(remaining - 1), 100);
      };

      const timer = setTimeout(() => retry(), 1000);

      socket.once('error', retry);
      socket.once('close', () => retry());
      socket.once('data', (chunk: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket.removeAllListeners('data');
        resolve({ socket, initial: chunk });
      });
    };
    attempt(attempts);
  });
}

function connectWithRetry(port: number, attempts = 40): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = (remaining: number) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', (err) => {
        socket.destroy();
        if (remaining <= 0) {
          reject(err);
          return;
        }
        setTimeout(() => attempt(remaining - 1), 100);
      });
    };
    attempt(attempts);
  });
}
