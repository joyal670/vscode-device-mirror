// Runs natively on each OS in CI, so the Windows branch of findAdb() is
// exercised with the real win32 path module, env vars and adb.exe name.
import { settings } from './vscode-stub';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findAdb, isNotFound } from '../adb';

const isWindows = process.platform === 'win32';
const exe = isWindows ? 'adb.exe' : 'adb';
const ENV_KEYS = ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];

let dir: string;
let savedEnv: Record<string, string | undefined>;

/** Create <root>/<...parts>/adb[.exe] and return its path. */
function fakeAdb(...parts: string[]): string {
  const folder = join(dir, ...parts);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, exe);
  writeFileSync(file, '');
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devicemirror-adb-'));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) delete process.env[k];
  // os.homedir() follows HOME (POSIX) / USERPROFILE (Windows).
  process.env.HOME = process.env.USERPROFILE = join(dir, 'home');
  process.env.LOCALAPPDATA = join(dir, 'localappdata');
  delete settings.adbPath;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('findAdb', () => {
  it('uses an explicit adbPath setting even if it does not exist', () => {
    settings.adbPath = join(dir, 'typo', exe);
    fakeAdb('sdk', 'platform-tools');
    process.env.ANDROID_HOME = join(dir, 'sdk');
    assert.equal(findAdb(), settings.adbPath);
  });

  it('prefers ANDROID_HOME, then ANDROID_SDK_ROOT', () => {
    const fromRoot = fakeAdb('root', 'platform-tools');
    process.env.ANDROID_SDK_ROOT = join(dir, 'root');
    assert.equal(findAdb(), fromRoot);
    const fromHome = fakeAdb('home-sdk', 'platform-tools');
    process.env.ANDROID_HOME = join(dir, 'home-sdk');
    assert.equal(findAdb(), fromHome);
  });

  it('skips an env var that points at a folder without adb', () => {
    process.env.ANDROID_HOME = join(dir, 'empty');
    const fromRoot = fakeAdb('root', 'platform-tools');
    process.env.ANDROID_SDK_ROOT = join(dir, 'root');
    assert.equal(findAdb(), fromRoot);
  });

  it('finds the Android Studio default SDK location for this OS', () => {
    const expected = isWindows
      ? fakeAdb('localappdata', 'Android', 'Sdk', 'platform-tools')
      : process.platform === 'darwin'
        ? fakeAdb('home', 'Library', 'Android', 'sdk', 'platform-tools')
        : fakeAdb('home', 'Android', 'Sdk', 'platform-tools');
    assert.equal(findAdb(), expected);
  });

  it(`falls back to ${exe} on PATH`, () => {
    assert.equal(findAdb(), exe);
  });
});

describe('isNotFound', () => {
  it('recognises ENOENT only', () => {
    assert.equal(isNotFound(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
    assert.equal(isNotFound(Object.assign(new Error('x'), { code: 'EACCES' })), false);
    assert.equal(isNotFound(undefined), false);
  });
});
