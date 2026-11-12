import { createHash } from 'crypto';
import { readFile } from 'fs/promises';

/**
 * The one scrcpy server release this extension speaks to.
 *
 * The server refuses to start unless the client passes its exact version, and
 * the control/stream protocol in control.ts and scrcpy.ts is written against
 * this release. Bumping it means re-checking both (see control.ts) and
 * updating SCRCPY_SERVER_SHA256 and scripts/fetch-server.js together.
 */
export const SCRCPY_VERSION = '3.1';

/** SHA-256 of the official scrcpy-server-v3.1 release asset. */
export const SCRCPY_SERVER_SHA256 = '958f0944a62f23b1f33a16e9eb14844c1a04b882ca175a738c16d23cb22b86c0';

const verified = new Map<string, Promise<void>>();

/**
 * Reject a missing or wrong scrcpy-server.jar with a message that says what
 * to do, instead of letting the server die on the device with an opaque
 * version mismatch. Hashing runs once per path per extension session.
 */
export function verifyServerJar(jarPath: string): Promise<void> {
  let check = verified.get(jarPath);
  if (!check) {
    check = hashJar(jarPath);
    verified.set(jarPath, check);
    // A failure isn't cached: the user may fetch the right jar and retry.
    check.catch(() => verified.delete(jarPath));
  }
  return check;
}

async function hashJar(jarPath: string): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(jarPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `scrcpy-server.jar not found at ${jarPath}. Run "npm run fetch-server" (see server/README.md).`,
        { cause: err },
      );
    }
    throw err;
  }
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== SCRCPY_SERVER_SHA256) {
    throw new Error(
      `${jarPath} is not the scrcpy ${SCRCPY_VERSION} server this extension needs ` +
        `(SHA-256 ${actual.slice(0, 12)}…, expected ${SCRCPY_SERVER_SHA256.slice(0, 12)}…). ` +
        'Run "npm run fetch-server" to replace it.',
    );
  }
}
