import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { verifyServerJar } from '../server';

const BUNDLED = join(__dirname, '..', '..', 'server', 'scrcpy-server.jar');
const dir = mkdtempSync(join(tmpdir(), 'devicemirror-jar-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyServerJar', () => {
  it('explains how to fetch a missing jar', async () => {
    await assert.rejects(verifyServerJar(join(dir, 'missing.jar')), /not found.*npm run fetch-server/);
  });

  it('rejects a jar that is not the pinned release', async () => {
    const wrong = join(dir, 'wrong.jar');
    writeFileSync(wrong, 'not scrcpy');
    await assert.rejects(verifyServerJar(wrong), /is not the scrcpy 3\.1 server.*npm run fetch-server/);
  });

  it('accepts the official 3.1 jar, and a fixed jar after a failure', { skip: !existsSync(BUNDLED) && 'run npm run fetch-server first' }, async () => {
    await verifyServerJar(BUNDLED);
    const later = join(dir, 'later.jar');
    writeFileSync(later, 'old');
    await assert.rejects(verifyServerJar(later));
    copyFileSync(BUNDLED, later); // the user replaced it: not stuck on the cached failure
    await verifyServerJar(later);
  });
});
