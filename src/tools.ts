import { ChildProcess, execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { adbExec } from './adb';

const execFileAsync = promisify(execFile);

/** Run adb and return trimmed text stdout; stderr is folded into errors. */
export async function adbText(
  adb: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const { stdout } = await execFileAsync(adb, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

/** Full-resolution PNG straight from the device framebuffer. */
export function screenshot(adb: string, serial: string): Promise<Buffer> {
  return adbExec(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], 64 * 1024 * 1024);
}

/**
 * `adb install` reports most failures as "Failure [REASON]" on stdout with a
 * zero exit code on older adb versions, so the output has to be checked too.
 */
export async function installApk(adb: string, serial: string, apkPath: string): Promise<void> {
  let out: string;
  try {
    out = await adbText(adb, ['-s', serial, 'install', '-r', '-d', apkPath], 10 * 60_000);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr || String(err), { cause: err });
  }
  if (!/\bSuccess\b/.test(out)) {
    throw new Error(out.split('\n').pop() || 'install failed');
  }
}

export const PUSH_DESTINATION = '/sdcard/Download/';

export async function pushFile(adb: string, serial: string, localPath: string): Promise<string> {
  try {
    await adbText(adb, ['-s', serial, 'push', localPath, PUSH_DESTINATION], 10 * 60_000);
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr || String(err), { cause: err });
  }
  const name = localPath.split(/[\\/]/).pop()!;
  // Without a media scan the file exists but Files/Gallery apps won't show it
  // until the next reboot. Best effort; older Android ignores this.
  void adbText(adb, [
    '-s', serial, 'shell', 'am', 'broadcast',
    '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file://${PUSH_DESTINATION}${name}`,
  ]).catch(() => undefined);
  return PUSH_DESTINATION + name;
}

/**
 * adb's own wording for "this computer can't reach the device over the
 * network", which on its own (e.g. "protocol fault (couldn't read status
 * message)") gives no clue that the network is the problem.
 */
const UNREACHABLE = /protocol fault|host is down|no route to host|timed out|connection refused|network is unreachable|failed to connect|cannot connect|unable to connect/i;

export function explainNetworkError(message: string): Error {
  if (!UNREACHABLE.test(message)) {
    return new Error(message);
  }
  return new Error(
    `${message}. This computer could not reach the device: check that both are on the same ` +
      'network and that the router does not isolate Wi-Fi clients from each other.',
  );
}

/** `adb pair` prints "Successfully paired" on success; anything else is a failure. */
export async function pairWifi(adb: string, hostPort: string, code: string): Promise<void> {
  let out: string;
  try {
    out = await adbText(adb, ['pair', hostPort, code], 30_000);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(err);
  }
  if (!/Successfully paired/i.test(out)) {
    throw explainNetworkError(out || 'pairing failed');
  }
}

/** `adb connect` exits 0 even on failure; success is "connected to …". */
export async function connectWifi(adb: string, hostPort: string): Promise<void> {
  const out = await adbText(adb, ['connect', hostPort], 15_000);
  if (!/connected to/i.test(out) || /failed|unable|cannot/i.test(out)) {
    throw explainNetworkError(out || 'connect failed');
  }
}

/**
 * Move a USB-attached device to adb-over-TCP on port 5555 and connect to it.
 * Returns the new serial (ip:5555). The USB serial stays usable until unplugged.
 */
export async function switchToWifi(adb: string, serial: string): Promise<string> {
  const ip = await deviceWifiIp(adb, serial);
  if (!ip) {
    throw new Error('the device has no Wi-Fi IP address; connect it to Wi-Fi first');
  }
  await adbText(adb, ['-s', serial, 'tcpip', '5555'], 15_000);
  // adbd restarts in TCP mode; connecting immediately races it.
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await connectWifi(adb, `${ip}:5555`);
      return `${ip}:5555`;
    } catch (err) {
      lastError = err;
    }
  }
  // Nothing could connect, so don't leave adbd listening on the network.
  // Restarting it in USB mode briefly drops the USB connection too; mirrors
  // reconnect on their own.
  await adbText(adb, ['-s', serial, 'usb'], 15_000).catch(() => undefined);
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message} The device has been put back in USB mode.`);
}

async function deviceWifiIp(adb: string, serial: string): Promise<string | undefined> {
  const out = await adbText(adb, ['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']).catch(
    () => '',
  );
  return /inet (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1];
}

const REMOTE_RECORDING = '/data/local/tmp/devicemirror-recording.mp4';

/**
 * Records with the device's own `screenrecord`: a real MP4 at full display
 * resolution, independent of the (possibly downscaled) mirror stream.
 * screenrecord stops itself after 3 minutes.
 *
 * Emits 'stopped' once the device-side process has exited for any reason.
 */
export class ScreenRecorder extends EventEmitter {
  private proc?: ChildProcess;
  private exited?: Promise<void>;
  readonly startedAt = Date.now();

  constructor(
    private readonly adb: string,
    readonly serial: string,
  ) {
    super();
  }

  start(): void {
    this.proc = spawn(this.adb, [
      '-s', this.serial, 'shell', 'screenrecord', '--bit-rate', '8000000', REMOTE_RECORDING,
    ]);
    let stderr = '';
    this.proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    this.proc.stdout?.on('data', (d: Buffer) => (stderr += d.toString()));
    this.exited = new Promise((resolve) => {
      this.proc!.on('close', (code) => {
        this.emit('stopped', code === 0 ? undefined : stderr.trim() || `exit ${code}`);
        resolve();
      });
    });
  }

  /**
   * SIGINT makes screenrecord finalise the MP4 (write the moov atom). Killing
   * the local `adb shell` instead would leave an unplayable file behind.
   */
  async stop(): Promise<void> {
    await adbText(this.adb, ['-s', this.serial, 'shell', 'pkill', '-INT', 'screenrecord']).catch(
      () => undefined,
    );
    await Promise.race([this.exited, new Promise((r) => setTimeout(r, 8000))]);
    // Give the device a moment to flush the file after the process exits.
    await new Promise((r) => setTimeout(r, 500));
  }

  /** Copy the finished recording to `localPath` and delete it from the device. */
  async saveTo(localPath: string): Promise<void> {
    await adbText(this.adb, ['-s', this.serial, 'pull', REMOTE_RECORDING, localPath], 5 * 60_000);
    await this.discard();
  }

  async discard(): Promise<void> {
    await adbText(this.adb, ['-s', this.serial, 'shell', 'rm', '-f', REMOTE_RECORDING]).catch(
      () => undefined,
    );
  }
}
