import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { Bridge, KIND_VIDEO } from '../bridge';

const WEBVIEW = 'vscode-webview://0123456789abcdef';

let bridge: Bridge | undefined;
const sockets: WebSocket[] = [];

async function start(): Promise<{ bridge: Bridge; port: number }> {
  bridge = new Bridge();
  const port = await bridge.listen();
  return { bridge, port };
}

/** Resolves 'open' with the socket, or the rejection reason. */
function connect(port: number, token: string | undefined, origin: string | undefined) {
  const url = `ws://127.0.0.1:${port}/` + (token === undefined ? '' : `?token=${token}`);
  const ws = new WebSocket(url, origin ? { origin } : {});
  sockets.push(ws);
  const received: unknown[] = [];
  ws.on('message', (data, isBinary) => received.push(isBinary ? data : JSON.parse(data.toString())));
  const opened = new Promise<'open' | string>((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(`HTTP ${res.statusCode}`));
    ws.on('error', (err) => resolve(err.message));
  });
  return { ws, received, opened };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  bridge?.dispose();
  bridge = undefined;
});

describe('Bridge access control', () => {
  it('accepts the webview with the right token and replays sticky state', async () => {
    const { bridge, port } = await start();
    bridge.sendSticky('meta', { type: 'meta', width: 1 });
    bridge.sendSticky('meta', { type: 'meta', width: 2 }); // latest wins
    bridge.sendSticky('state', { type: 'state', state: 'streaming' });
    const c = connect(port, bridge.token, WEBVIEW);
    assert.equal(await c.opened, 'open');
    await until(() => c.received.length === 2);
    assert.deepEqual(c.received, [{ type: 'meta', width: 2 }, { type: 'state', state: 'streaming' }]);
  });

  for (const [name, token, origin] of [
    ['no token', undefined, WEBVIEW],
    ['a wrong token', 'f'.repeat(64), WEBVIEW],
    ['a short token', 'abc', WEBVIEW],
    ['no origin', 'TOKEN', undefined],
    ['a web page origin', 'TOKEN', 'https://example.com'],
  ] as const) {
    it(`rejects ${name}`, async () => {
      const { bridge, port } = await start();
      const c = connect(port, token === 'TOKEN' ? bridge.token : token, origin);
      assert.equal(await c.opened, 'HTTP 401');
    });
  }

  it('rejects a second client while one is connected', async () => {
    const { bridge, port } = await start();
    const first = connect(port, bridge.token, WEBVIEW);
    assert.equal(await first.opened, 'open');
    const second = connect(port, bridge.token, WEBVIEW);
    assert.equal(await second.opened, 'HTTP 401');
  });

  it('accepts a reconnect once the first client has gone', async () => {
    const { bridge, port } = await start();
    const first = connect(port, bridge.token, WEBVIEW);
    assert.equal(await first.opened, 'open');
    first.ws.close();
    await new Promise((r) => first.ws.on('close', r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await connect(port, bridge.token, WEBVIEW).opened, 'open');
  });
});

describe('Bridge messages', () => {
  it('frames binary with kind and flags, and delivers JSON from the webview', async () => {
    const { bridge, port } = await start();
    const inbound: unknown[] = [];
    bridge.onMessage((m) => inbound.push(m));
    const c = connect(port, bridge.token, WEBVIEW);
    assert.equal(await c.opened, 'open');

    bridge.sendBinary(KIND_VIDEO, 0x03, Buffer.from([0xaa, 0xbb]));
    await until(() => c.received.length === 1);
    assert.deepEqual(c.received[0], Buffer.from([KIND_VIDEO, 0x03, 0xaa, 0xbb]));

    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'touch', x: 1 }));
    await until(() => inbound.length === 1);
    assert.deepEqual(inbound, [{ type: 'touch', x: 1 }]);
  });

  it('drops oversized messages from the webview', async () => {
    const { bridge, port } = await start();
    const c = connect(port, bridge.token, WEBVIEW);
    assert.equal(await c.opened, 'open');
    const closed = new Promise<number>((r) => c.ws.on('close', (code) => r(code)));
    c.ws.send('x'.repeat(65 * 1024));
    assert.equal(await closed, 1009); // message too big
  });
});
