import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import * as net from 'net';
import { adbExec } from './adb';
import { DeviceMessage, parseDeviceMessages } from './control';

export type VideoCodec = 'h264' | 'h265' | 'av1';

export interface MediaPacket {
  isConfig: boolean;
  isKeyFrame: boolean;
  /** Microseconds, device clock. Meaningless (0) for config packets. */
  pts: bigint;
  payload: Buffer;
}

/** Kept for existing imports; video and audio packets share one shape. */
export type VideoPacket = MediaPacket;

export interface StreamMeta {
  deviceName: string;
  codec: VideoCodec;
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
  videoCodec?: VideoCodec;
  /** Bits per second; 0/undefined leaves the server default (8 Mbps). */
  videoBitRate?: number;
  /**
   * Forward device audio (Android 11+) as raw 16-bit stereo PCM at 48 kHz.
   * Raw because VS Code's Electron ships no WebCodecs audio decoders (Opus
   * and AAC both report unsupported), so encoded audio could not be played.
   */
  audio?: boolean;
  /** Keep the device awake while mirroring (restored on exit). */
  stayAwake?: boolean;
  scid?: string;
  /** 'debug' surfaces PositionMapper's rejection of mis-sized input events. */
  logLevel?: 'verbose' | 'debug' | 'info' | 'warn' | 'error';
}

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';

/** 4-byte codec ids at the head of each stream (`send_codec_meta`). */
const CODEC_IDS: Record<number, string> = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x00617631: 'av1',
  0x6f707573: 'opus',
  0x00616163: 'aac',
  0x666c6163: 'flac',
  0x00726177: 'raw',
};
/** Audio stream codec id meaning "audio disabled on the device side". */
const AUDIO_DISABLED = 0;
/** Audio stream codec id meaning "audio capture failed". */
const AUDIO_ERROR = 1;

/**
 * Owns one scrcpy server process and its sockets: video, optional audio, and
 * control — accepted in that order on the same forwarded port.
 *
 * Emits:
 *   'meta'         (StreamMeta)    once, after the video header is parsed
 *   'packet'       (MediaPacket)   per encoded video frame
 *   'audioMeta'    ({codec})       once audio is known to be flowing
 *   'audioPacket'  (MediaPacket)   per encoded audio frame
 *   'audioUnavailable' (string)   device could not capture audio
 *   'clipboard'    (string)        device clipboard changed (autosync)
 *   'log'          (string)        server stdout/stderr
 *   'close'        ()              server or socket went away (once; never after dispose)
 */
export class ScrcpySession extends EventEmitter {
  private proc?: ChildProcess;
  private videoSocket?: net.Socket;
  private audioSocket?: net.Socket;
  private controlSocket?: net.Socket;
  private disposed = false;
  /** Local end of the adb forward; set once adb has allocated it. */
  private port?: number;
  private deviceInbox = Buffer.alloc(0);

  constructor(private readonly opts: ScrcpyOptions) {
    super();
  }

  async start(): Promise<void> {
    const { adb, serial, serverJar, version, maxSize, maxFps } = this.opts;
    const videoCodec = this.opts.videoCodec ?? 'h264';
    const audio = this.opts.audio ?? false;
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
    this.throwIfDisposed();

    // tcp:0 => adb picks a free local port and prints it, so concurrent
    // sessions (or other tools) can never collide on a forward rule.
    const allocated = await adbExec(adb, [
      '-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`,
    ]);
    const port = Number.parseInt(allocated.toString().trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`adb forward did not report a port: ${allocated.toString()}`);
    }
    this.port = port;
    // If the panel closed while adb was working, dispose() already ran and
    // could not see this forward; remove it here instead of leaking it.
    if (this.disposed) {
      await this.removeForward();
      this.throwIfDisposed();
    }

    // Arg format is version-specific. These are scrcpy 2.x/3.x key=value args.
    //
    // ONLY pass what differs from the server defaults. Some devices abort
    // app_process natively ("stack corruption detected") once the shell
    // command passes ~300 characters — measured on a Samsung SM-A145P running
    // Android 15: 296 ran, 312 crashed before streaming a single frame. The
    // scrcpy client avoids this the same way. Defaults relied on here:
    // control, cleanup, clipboard_autosync, send_device_meta, send_frame_meta,
    // send_codec_meta and send_dummy_byte are all true; log_level is info;
    // video_codec is h264.
    const command = [
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', version,
      `scid=${scid}`,
      'tunnel_forward=true',
      `max_size=${maxSize}`,
      `max_fps=${maxFps}`,
    ];
    if (audio) {
      command.push('audio_codec=raw');
    } else {
      command.push('audio=false'); // audio defaults to ON
    }
    if (videoCodec !== 'h264') {
      command.push(`video_codec=${videoCodec}`);
    }
    if (this.opts.logLevel && this.opts.logLevel !== 'info') {
      command.push(`log_level=${this.opts.logLevel}`);
    }
    if (this.opts.videoBitRate && this.opts.videoBitRate > 0) {
      command.push(`video_bit_rate=${Math.round(this.opts.videoBitRate)}`);
    }
    if (this.opts.stayAwake) {
      command.push('stay_awake=true');
    }
    const length = command.join(' ').length;
    if (length > 260) {
      this.emit('log', `warning: server command is ${length} chars; some devices crash past ~300`);
    }
    this.proc = spawn(adb, ['-s', serial, 'shell', ...command]);

    this.proc.stdout?.on('data', (d: Buffer) => this.emit('log', d.toString()));
    this.proc.stderr?.on('data', (d: Buffer) => this.emit('log', d.toString()));
    this.proc.on('close', () => this.emitClose());

    // `adb forward` to a dead localabstract socket still ACCEPTS the TCP
    // connection — adb takes it, fails to open the remote end, then closes. So
    // waiting for 'connect' alone can hand back a corpse that silently yields
    // zero frames. Wait for the handshake byte instead.
    const { socket, initial } = await connectVideoWithRetry(port);
    this.videoSocket = socket;
    if (audio) {
      this.audioSocket = await connectWithRetry(port);
    }
    this.controlSocket = await connectWithRetry(port);
    if (this.disposed) {
      // dispose() ran mid-handshake, before these sockets existed.
      this.videoSocket.destroy();
      this.audioSocket?.destroy();
      this.controlSocket.destroy();
      this.throwIfDisposed();
    }

    this.wireVideo(this.videoSocket, initial);
    if (this.audioSocket) {
      this.wireAudio(this.audioSocket);
    }

    this.controlSocket.on('data', (chunk: Buffer) => this.consumeDeviceMessages(chunk));
    this.controlSocket.on('error', (err) => this.emit('log', `control socket: ${err}`));
  }

  /**
   * Video stream (with send_dummy_byte + send_device_meta + send_codec_meta +
   * send_frame_meta):
   *   [1]  dummy 0x00            <- only on the first socket; drop it or every
   *   [64] device name, NUL-pad     subsequent offset is wrong
   *   [12] codec id | width | height
   *   then repeating packets, see PacketReader.
   */
  private wireVideo(socket: net.Socket, initial: Buffer): void {
    const reader = new StreamReader();
    let stage: 'dummy' | 'deviceMeta' | 'codecMeta' | 'packets' = 'dummy';
    let deviceName = 'device';

    const pump = (chunk: Buffer) => {
      reader.push(chunk);
      for (;;) {
        if (stage === 'dummy') {
          if (!reader.take(1)) return;
          stage = 'deviceMeta';
        } else if (stage === 'deviceMeta') {
          const raw = reader.take(64);
          if (!raw) return;
          deviceName = raw.toString('utf8').replace(/\0.*$/s, '');
          stage = 'codecMeta';
        } else if (stage === 'codecMeta') {
          const raw = reader.take(12);
          if (!raw) return;
          const codec = (CODEC_IDS[raw.readUInt32BE(0)] ?? 'h264') as VideoCodec;
          stage = 'packets';
          this.emit('meta', {
            deviceName,
            codec,
            width: raw.readUInt32BE(4),
            height: raw.readUInt32BE(8),
          } satisfies StreamMeta);
        } else {
          const packet = reader.takePacket();
          if (!packet) return;
          this.emit('packet', packet);
        }
      }
    };

    socket.on('data', pump);
    pump(initial); // the bytes already read during the handshake
    socket.on('close', () => this.emitClose());
    socket.on('error', (err) => this.emit('log', `video socket: ${err}`));
  }

  /**
   * Audio stream: [4] codec id, then packets. A codec id of 0 or 1 means the
   * device can't capture audio (Android < 11, or capture failed) and the
   * stream ends there — that is not a reason to tear down video.
   */
  private wireAudio(socket: net.Socket): void {
    const reader = new StreamReader();
    let stage: 'codecMeta' | 'packets' | 'off' = 'codecMeta';

    socket.on('data', (chunk: Buffer) => {
      if (stage === 'off') return;
      reader.push(chunk);
      for (;;) {
        if (stage === 'codecMeta') {
          const raw = reader.take(4);
          if (!raw) return;
          const id = raw.readUInt32BE(0);
          if (id === AUDIO_DISABLED || id === AUDIO_ERROR) {
            stage = 'off';
            this.emit(
              'audioUnavailable',
              id === AUDIO_DISABLED
                ? 'audio forwarding needs Android 11 or later'
                : 'the device failed to start audio capture',
            );
            return;
          }
          stage = 'packets';
          this.emit('audioMeta', { codec: CODEC_IDS[id] ?? `0x${id.toString(16)}` });
        } else if (stage === 'packets') {
          const packet = reader.takePacket();
          if (!packet) return;
          this.emit('audioPacket', packet);
        } else {
          return;
        }
      }
    });
    // Audio ending alone is not fatal; the video socket decides 'close'.
    socket.on('error', (err) => this.emit('log', `audio socket: ${err}`));
  }

  private consumeDeviceMessages(chunk: Buffer): void {
    this.deviceInbox = Buffer.concat([this.deviceInbox, chunk]);
    let parsed: { messages: DeviceMessage[]; rest: Buffer };
    try {
      parsed = parseDeviceMessages(this.deviceInbox);
    } catch (err) {
      // Desynced; nothing after this point can be trusted.
      this.emit('log', `control socket: ${err}; ignoring further device messages`);
      this.deviceInbox = Buffer.alloc(0);
      this.controlSocket?.removeAllListeners('data');
      return;
    }
    this.deviceInbox = Buffer.from(parsed.rest);
    for (const message of parsed.messages) {
      if (message.type === 'clipboard') {
        this.emit('clipboard', message.text);
      }
    }
  }

  /**
   * The process and the video socket both report the end of the stream, and
   * dispose() triggers both. Emit once, and only for an end we didn't cause,
   * so the panel never tries to reconnect a session it is tearing down.
   */
  private closeEmitted = false;
  private emitClose(): void {
    if (this.closeEmitted || this.disposed) return;
    this.closeEmitted = true;
    this.emit('close');
  }

  sendControl(message: Buffer): void {
    this.controlSocket?.write(message);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.videoSocket?.destroy();
    this.audioSocket?.destroy();
    this.controlSocket?.destroy();
    this.proc?.kill();

    // Leaking a forward per reload is the classic way to end up with a
    // hundred dead tcp: rules, so always remove it.
    await this.removeForward();
  }

  private async removeForward(): Promise<void> {
    const port = this.port;
    if (port === undefined) return;
    this.port = undefined;
    try {
      await adbExec(this.opts.adb, [
        '-s', this.opts.serial, 'forward', '--remove', `tcp:${port}`,
      ]);
    } catch {
      // The device may already be gone; nothing useful to do.
    }
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Error('session closed during startup');
    }
  }
}

/**
 * Accumulates socket chunks and hands out fixed-size slices or whole packets.
 *
 * Packet layout (send_frame_meta):
 *   [8]  pts (bit63 = config packet, bit62 = key frame)
 *   [4]  payload length
 *   [N]  payload
 *
 * Chunks are kept in a list and only joined when a read spans them, so a
 * large key frame arriving in many chunks is copied once, not once per chunk.
 */
export class StreamReader {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get available(): number {
    return this.length;
  }

  /** Remove and return exactly `n` bytes, or undefined if not yet available. */
  take(n: number): Buffer | undefined {
    if (this.length < n) return undefined;
    const head = this.peek(n);
    this.skip(n);
    return head;
  }

  takePacket(): MediaPacket | undefined {
    if (this.length < 12) return undefined;
    const header = this.peek(12);
    const size = header.readUInt32BE(8);
    if (this.length < 12 + size) return undefined;
    this.skip(12);
    const payload = this.take(size)!;
    const pts = header.readBigUInt64BE(0);
    return {
      isConfig: (pts & (1n << 63n)) !== 0n,
      isKeyFrame: (pts & (1n << 62n)) !== 0n,
      pts: pts & ((1n << 62n) - 1n),
      payload,
    };
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) {
      return Buffer.from(this.chunks[0].subarray(0, n));
    }
    const out = Buffer.alloc(n);
    let copied = 0;
    for (const chunk of this.chunks) {
      const count = Math.min(chunk.length, n - copied);
      chunk.copy(out, copied, 0, count);
      copied += count;
      if (copied === n) break;
    }
    return out;
  }

  private skip(n: number): void {
    this.length -= n;
    while (n > 0) {
      const first = this.chunks[0];
      if (first.length <= n) {
        n -= first.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(n);
        n = 0;
      }
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
