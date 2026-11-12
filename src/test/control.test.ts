// Byte layouts below are written out by hand from the scrcpy 3.1 server's
// ControlMessageReader / DeviceMessageWriter, not derived from control.ts, so a
// change to an encoder that the server would misread fails here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTION_DOWN,
  ACTION_MOVE,
  ACTION_UP,
  backOrScreenOn,
  collapsePanels,
  COPY_KEY_CUT,
  expandNotificationPanel,
  expandSettingsPanel,
  getClipboard,
  injectText,
  KEY_ACTION_UP,
  keycodeEvent,
  keyPress,
  parseDeviceMessages,
  POINTER_ID_VIRTUAL_FINGER,
  resetVideo,
  rotateDevice,
  scrollEvent,
  setClipboard,
  setDisplayPower,
  touchEvent,
} from '../control';

const hex = (b: Buffer) => b.toString('hex');

describe('touchEvent', () => {
  it('encodes a generic-finger down with full pressure', () => {
    const buf = touchEvent({ action: ACTION_DOWN, x: 100, y: 200, screenWidth: 1080, screenHeight: 2400 });
    assert.equal(buf.length, 32);
    assert.equal(
      hex(buf),
      '02' + // INJECT_TOUCH_EVENT
        '00' + // ACTION_DOWN
        'fffffffffffffffe' + // pointer id -2 (generic finger)
        '00000064' + '000000c8' + // x, y
        '0438' + '0960' + // screen 1080 x 2400
        'ffff' + // pressure 1.0 (u16 fixed point)
        '00000000' + '00000000', // actionButton, buttons
    );
  });

  it('sends zero pressure on release, whatever was asked', () => {
    const buf = touchEvent({ action: ACTION_UP, x: 1, y: 1, screenWidth: 10, screenHeight: 10, pressure: 0.8 });
    assert.equal(buf.readUInt8(1), ACTION_UP);
    assert.equal(buf.readUInt16BE(22), 0);
  });

  it('scales and clamps pressure, rounds coordinates, honours the pointer id', () => {
    const half = touchEvent({ action: ACTION_MOVE, x: 10.6, y: 3.2, screenWidth: 10, screenHeight: 10, pressure: 0.3 });
    assert.equal(half.readUInt16BE(22), Math.round(0.3 * 0xffff));
    assert.equal(half.readUInt32BE(10), 11);
    assert.equal(half.readUInt32BE(14), 3);
    const over = touchEvent({ action: ACTION_MOVE, x: 0, y: 0, screenWidth: 10, screenHeight: 10, pressure: 7 });
    assert.equal(over.readUInt16BE(22), 0xffff);
    const virt = touchEvent({ action: ACTION_DOWN, x: 0, y: 0, screenWidth: 10, screenHeight: 10, pointerId: POINTER_ID_VIRTUAL_FINGER });
    assert.equal(virt.readBigInt64BE(2), -3n);
  });
});

describe('key and text events', () => {
  it('encodes a keycode with repeat and meta state', () => {
    assert.equal(
      hex(keycodeEvent(66, KEY_ACTION_UP, 2, 0x1001)),
      '00' + '01' + '00000042' + '00000002' + '00001001',
    );
  });

  it('keyPress is down then up', () => {
    const buf = keyPress(3);
    assert.equal(buf.length, 28);
    assert.equal(hex(buf), '00' + '00' + '00000003' + '00000000' + '00000000' + '00' + '01' + '00000003' + '00000000' + '00000000');
  });

  it('length-prefixes text in UTF-8 bytes, not characters', () => {
    const buf = injectText('ü✓');
    assert.equal(hex(buf), '01' + '00000005' + 'c3bc' + 'e29c93');
  });
});

describe('scrollEvent', () => {
  it('encodes position and i16 fixed-point scroll amounts', () => {
    const buf = scrollEvent({ x: 5, y: 6, screenWidth: 100, screenHeight: 200, hscroll: 0, vscroll: -0.5 });
    assert.equal(buf.length, 21);
    assert.equal(hex(buf), '03' + '00000005' + '00000006' + '0064' + '00c8' + '0000' + 'c001' + '00000000');
  });

  it('clamps to the -1..1 range the server decodes', () => {
    const buf = scrollEvent({ x: 0, y: 0, screenWidth: 1, screenHeight: 1, hscroll: 9, vscroll: -9 });
    assert.equal(buf.readInt16BE(13), 0x7fff);
    assert.equal(buf.readInt16BE(15), -0x8000);
  });
});

describe('one-byte and two-byte commands', () => {
  it('match the server message type ids', () => {
    assert.equal(hex(backOrScreenOn(ACTION_UP)), '0401');
    assert.equal(hex(expandNotificationPanel()), '05');
    assert.equal(hex(expandSettingsPanel()), '06');
    assert.equal(hex(collapsePanels()), '07');
    assert.equal(hex(getClipboard(COPY_KEY_CUT)), '0802');
    assert.equal(hex(setDisplayPower(false)), '0a00');
    assert.equal(hex(setDisplayPower(true)), '0a01');
    assert.equal(hex(rotateDevice()), '0b');
    assert.equal(hex(resetVideo()), '11');
  });

  it('setClipboard carries sequence, paste flag and UTF-8 text', () => {
    assert.equal(hex(setClipboard('hé', true, 7n)), '09' + '0000000000000007' + '01' + '00000003' + '68c3a9');
    assert.equal(hex(setClipboard('', false)), '09' + '0000000000000000' + '00' + '00000000');
  });
});

describe('parseDeviceMessages', () => {
  const clipboard = (text: string) => {
    const payload = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(5);
    head.writeUInt8(0, 0);
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const ack = (seq: bigint) => {
    const b = Buffer.alloc(9);
    b.writeUInt8(1, 0);
    b.writeBigUInt64BE(seq, 1);
    return b;
  };

  it('parses several messages from one buffer', () => {
    const { messages, rest } = parseDeviceMessages(Buffer.concat([clipboard('a'), ack(42n), clipboard('ü')]));
    assert.deepEqual(messages, [
      { type: 'clipboard', text: 'a' },
      { type: 'ackClipboard', sequence: 42n },
      { type: 'clipboard', text: 'ü' },
    ]);
    assert.equal(rest.length, 0);
  });

  it('keeps an incomplete message as the tail, at every split point', () => {
    const whole = Buffer.concat([clipboard('héllo'), ack(1n)]);
    for (let cut = 0; cut <= whole.length; cut++) {
      const first = parseDeviceMessages(whole.subarray(0, cut));
      const second = parseDeviceMessages(Buffer.concat([first.rest, whole.subarray(cut)]));
      assert.deepEqual([...first.messages, ...second.messages], [
        { type: 'clipboard', text: 'héllo' },
        { type: 'ackClipboard', sequence: 1n },
      ], `split at ${cut}`);
      assert.equal(second.rest.length, 0);
    }
  });

  it('skips UHID output without losing sync', () => {
    const uhid = Buffer.from([2, 0, 1, 0, 3, 0xaa, 0xbb, 0xcc]);
    const { messages } = parseDeviceMessages(Buffer.concat([uhid, ack(5n)]));
    assert.deepEqual(messages, [{ type: 'ackClipboard', sequence: 5n }]);
  });

  it('throws on an unknown type instead of reading garbage', () => {
    assert.throws(() => parseDeviceMessages(Buffer.from([9, 0, 0])), /unknown device message type 9/);
  });
});
