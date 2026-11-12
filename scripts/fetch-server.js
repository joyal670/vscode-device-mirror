#!/usr/bin/env node
// Downloads the scrcpy server this extension is pinned to into
// server/scrcpy-server.jar and refuses it unless the SHA-256 matches.
// Keep VERSION and SHA256 in step with src/server.ts.
'use strict';

const { createHash } = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const VERSION = '3.1';
const SHA256 = '958f0944a62f23b1f33a16e9eb14844c1a04b882ca175a738c16d23cb22b86c0';
const URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const DEST = path.join(__dirname, '..', 'server', 'scrcpy-server.jar');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'fetch-server-script' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects === 0) return reject(new Error('too many redirects'));
          return resolve(download(new globalThis.URL(res.headers.location, url).href, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(DEST) && sha256(fs.readFileSync(DEST)) === SHA256) {
    console.log(`server/scrcpy-server.jar is already scrcpy ${VERSION}.`);
    return;
  }
  console.log(`Downloading ${URL}`);
  const data = await download(URL);
  const actual = sha256(data);
  if (actual !== SHA256) {
    throw new Error(`SHA-256 mismatch: got ${actual}, expected ${SHA256}. Not saved.`);
  }
  fs.writeFileSync(DEST, data);
  console.log(`Saved server/scrcpy-server.jar (scrcpy ${VERSION}, ${data.length} bytes, SHA-256 verified).`);
})().catch((err) => {
  console.error(`fetch-server: ${err.message}`);
  process.exit(1);
});
