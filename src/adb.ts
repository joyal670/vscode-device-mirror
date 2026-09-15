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
}

/**
 * adb is very often not on PATH (it isn't on this machine), so probe the
 * places Android Studio actually installs it before giving up.
 */
export function findAdb(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('deviceMirror')
    .get<string>('adbPath');
  if (configured && existsSync(configured)) {
    return configured;
  }

  const candidates: string[] = [];
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const root = process.env[envVar];
    if (root) {
      candidates.push(path.join(root, 'platform-tools', 'adb'));
    }
  }
  candidates.push(
    path.join(homedir(), 'Library/Android/sdk/platform-tools/adb'), // macOS
    path.join(homedir(), 'Android/Sdk/platform-tools/adb'), // Linux
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Android/Sdk/platform-tools/adb.exe',
    ), // Windows
  );

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  // Last resort: hope it is on PATH.
  return 'adb';
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
      return { serial, state, model };
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
