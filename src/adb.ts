import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface Device {
  serial: string;
  state: string;
  model?: string;
  /**
   * adb's id for this attachment. A device that disconnects and re-attaches
   * gets a new one, even if it was gone too briefly for polling to notice.
   */
  transportId?: string;
}

/**
 * adb is very often not on PATH (it isn't on this machine), so probe the
 * places Android Studio actually installs it before giving up.
 */
export function findAdb(): string {
  const configured = vscode.workspace
    .getConfiguration('deviceMirror')
    .get<string>('adbPath');
  if (configured) {
    // Honour an explicit setting even if it is wrong: silently falling back
    // would hide the typo. The caller reports ENOENT against this path.
    return configured;
  }

  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[envVar];
    if (root) {
      candidates.push(path.join(root, 'platform-tools', exe));
    }
  }
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe));
    }
  } else {
    candidates.push(
      path.join(homedir(), 'Library/Android/sdk/platform-tools', exe), // macOS
      path.join(homedir(), 'Android/Sdk/platform-tools', exe), // Linux
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Last resort: hope it is on PATH. If it isn't, the first exec fails with
  // ENOENT and the caller turns that into an actionable message.
  return exe;
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Every entry adb reports, including `unauthorized` and `offline` ones.
 * Callers filter on `state === 'device'`; keeping the rest lets the UI tell
 * "nothing is plugged in" apart from "plugged in but not authorised", which
 * are completely different fixes for the user.
 */
export async function listDevices(adb: string): Promise<Device[]> {
  const { stdout } = await execFileAsync(adb, ['devices', '-l']);
  return stdout
    .split('\n')
    .slice(1) // drop "List of devices attached"
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest
        .find((token) => token.startsWith('model:'))
        ?.slice('model:'.length)
        .replace(/_/g, ' ');
      const transportId = rest
        .find((token) => token.startsWith('transport_id:'))
        ?.slice('transport_id:'.length);
      return { serial, state, model, transportId };
    });
}

/** Physical screen size, used to scale normalised touch coordinates. */
export async function getScreenSize(
  adb: string,
  serial: string,
): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(adb, ['-s', serial, 'shell', 'wm', 'size']);
  // "Physical size: 720x1600" — an override line may follow; the last wins.
  const matches = [...stdout.matchAll(/(\d+)x(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) {
    throw new Error(`Could not parse screen size from: ${stdout}`);
  }
  return { width: Number(last[1]), height: Number(last[2]) };
}

export async function adbExec(
  adb: string,
  args: string[],
  maxBuffer = 1024 * 1024 * 16,
): Promise<Buffer> {
  const { stdout } = await execFileAsync(adb, args, {
    encoding: 'buffer',
    maxBuffer,
  });
  return stdout as Buffer;
}

/**
 * Re-attach a network device (`host:port` serial) that adb has dropped. USB
 * serials can't be reconnected this way, so this is a no-op for them.
 */
export async function reconnectNetworkDevice(adb: string, serial: string): Promise<void> {
  if (!/^[^:]+:\d+$/.test(serial)) return;
  try {
    await execFileAsync(adb, ['connect', serial], { timeout: 5000 });
  } catch {
    // Still unreachable; the caller polls again.
  }
}
