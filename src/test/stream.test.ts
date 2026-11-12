import './vscode-stub';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StreamReader } from '../scrcpy';

/** A scrcpy media packet: 8-byte pts (bit 63 config, bit 62 key frame) + 4-byte size + payload. */
function packet(pts: bigint, payload: Buffer, opts: { config?: boolean; key?: boolean } = {}): Buffer {
  const header = Buffer.alloc(12);
  let flags = pts;
  if (opts.config) flags |= 1n << 63n;
  if (opts.key) flags |= 1n << 62n;
  header.writeBigUInt64BE(flags, 0);
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

describe('StreamReader', () => {
  it('decodes config and key-frame flags and strips them from pts', () => {
    const r = new StreamReader();
    r.push(packet(0n, Buffer.from('sps'), { config: true }));
    r.push(packet(1234n, Buffer.from('idr'), { key: true }));
    r.push(packet(5678n, Buffer.from('p')));
    assert.deepEqual(r.takePacket(), { isConfig: true, isKeyFrame: false, pts: 0n, payload: Buffer.from('sps') });
    assert.deepEqual(r.takePacket(), { isConfig: false, isKeyFrame: true, pts: 1234n, payload: Buffer.from('idr') });
    assert.deepEqual(r.takePacket(), { isConfig: false, isKeyFrame: false, pts: 5678n, payload: Buffer.from('p') });
    assert.equal(r.takePacket(), undefined);
    assert.equal(r.available, 0);
  });

  it('reassembles packets delivered one byte at a time', () => {
    const payloads = [Buffer.alloc(0), Buffer.from('a'), Buffer.alloc(3000, 7)];
    const wire = Buffer.concat(payloads.map((p, i) => packet(BigInt(i), p)));
    const r = new StreamReader();
    const got: Buffer[] = [];
    for (const byte of wire) {
      r.push(Buffer.from([byte]));
      for (let p = r.takePacket(); p; p = r.takePacket()) got.push(p.payload);
    }
    assert.deepEqual(got, payloads);
    assert.equal(r.available, 0);
  });

  it('take() waits for enough bytes and spans chunks', () => {
    const r = new StreamReader();
    r.push(Buffer.from('ab'));
    assert.equal(r.take(3), undefined);
    assert.equal(r.available, 2);
    r.push(Buffer.from('cdef'));
    assert.deepEqual(r.take(3), Buffer.from('abc'));
    assert.deepEqual(r.take(3), Buffer.from('def'));
    assert.equal(r.available, 0);
  });

  it('returned buffers do not alias later input', () => {
    const r = new StreamReader();
    const chunk = Buffer.from('xyz');
    r.push(chunk);
    const head = r.take(2)!;
    chunk.write('QQQ');
    assert.deepEqual(head, Buffer.from('xy'));
  });
});
