/**
 * scrcpy control-message encoders.
 *
 * WARNING: this byte layout is version-specific. It matches scrcpy 2.x/3.x.
 * If you bump the bundled scrcpy-server.jar, re-check ControlMessageReader.java
 * in the matching tag before trusting these offsets.
 */

export const TYPE_INJECT_KEYCODE = 0;
export const TYPE_INJECT_TEXT = 1;
export const TYPE_INJECT_TOUCH_EVENT = 2;
export const TYPE_INJECT_SCROLL_EVENT = 3;
export const TYPE_BACK_OR_SCREEN_ON = 4;
export const TYPE_EXPAND_NOTIFICATION_PANEL = 5;
export const TYPE_EXPAND_SETTINGS_PANEL = 6;
export const TYPE_COLLAPSE_PANELS = 7;
export const TYPE_GET_CLIPBOARD = 8;
export const TYPE_SET_CLIPBOARD = 9;
export const TYPE_SET_DISPLAY_POWER = 10;
export const TYPE_ROTATE_DEVICE = 11;
/** scrcpy 3.x; verified present in the bundled 3.1 server. */
export const TYPE_RESET_VIDEO = 17;

export const ACTION_DOWN = 0;
export const ACTION_UP = 1;
export const ACTION_MOVE = 2;

/** Android KeyEvent action codes. */
export const KEY_ACTION_DOWN = 0;
export const KEY_ACTION_UP = 1;

/** Android keycodes worth exposing as on-screen buttons. */
export const KEYCODE_HOME = 3;
export const KEYCODE_BACK = 4;
export const KEYCODE_APP_SWITCH = 187;
export const KEYCODE_POWER = 26;
export const KEYCODE_VOLUME_UP = 24;
export const KEYCODE_VOLUME_DOWN = 25;

/**
 * scrcpy branches on the pointer id: POINTER_ID_MOUSE (-1) is injected as
 * SOURCE_MOUSE / TOOL_TYPE_MOUSE and depends on correct button state, which
 * devices handle inconsistently. Anything else is injected as a plain
 * SOURCE_TOUCHSCREEN finger, which is what we actually want.
 */
export const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen; // -2
/** Second finger for pinch/rotate gestures, as the scrcpy client uses. */
export const POINTER_ID_VIRTUAL_FINGER = 0xfffffffffffffffdn; // -3

/** GET_CLIPBOARD copy_key: what the device should do before reporting. */
export const COPY_KEY_NONE = 0;
export const COPY_KEY_COPY = 1;
export const COPY_KEY_CUT = 2;

export function touchEvent(opts: {
  action: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pressure?: number;
  pointerId?: bigint;
}): Buffer {
  // 1 type + 1 action + 8 pointerId + 12 position + 2 pressure
  // + 4 actionButton + 4 buttons = 32
  const buf = Buffer.alloc(32);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, off); off += 1;
  buf.writeUInt8(opts.action, off); off += 1;
  buf.writeBigUInt64BE(opts.pointerId ?? POINTER_ID_GENERIC_FINGER, off); off += 8;
  buf.writeUInt32BE(Math.round(opts.x), off); off += 4;
  buf.writeUInt32BE(Math.round(opts.y), off); off += 4;
  buf.writeUInt16BE(opts.screenWidth, off); off += 2;
  buf.writeUInt16BE(opts.screenHeight, off); off += 2;

  // Pressure is 16-bit fixed point: 0xffff == 1.0.
  const pressure = opts.action === ACTION_UP ? 0 : (opts.pressure ?? 1);
  buf.writeUInt16BE(Math.round(Math.min(1, pressure) * 0xffff), off); off += 2;

  // A finger has no buttons; both fields stay zero.
  buf.writeUInt32BE(0, off); off += 4; // actionButton
  buf.writeUInt32BE(0, off); // buttons
  return buf;
}

export function keycodeEvent(
  keycode: number,
  action: number = KEY_ACTION_DOWN,
  repeat = 0,
  metaState = 0,
): Buffer {
  // 1 type + 1 action + 4 keycode + 4 repeat + 4 metaState = 14
  const buf = Buffer.alloc(14);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_KEYCODE, off); off += 1;
  buf.writeUInt8(action, off); off += 1;
  buf.writeUInt32BE(keycode, off); off += 4;
  buf.writeUInt32BE(repeat, off); off += 4;
  buf.writeUInt32BE(metaState, off);
  return buf;
}

/** A key press is down + up; callers almost always want both. */
export function keyPress(keycode: number): Buffer {
  return Buffer.concat([
    keycodeEvent(keycode, KEY_ACTION_DOWN),
    keycodeEvent(keycode, KEY_ACTION_UP),
  ]);
}

export function injectText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(5 + payload.length);
  buf.writeUInt8(TYPE_INJECT_TEXT, 0);
  buf.writeUInt32BE(payload.length, 1);
  payload.copy(buf, 5);
  return buf;
}

export function scrollEvent(opts: {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  hscroll: number;
  vscroll: number;
}): Buffer {
  // 1 type + 12 position + 2 hscroll + 2 vscroll + 4 buttons = 21
  const buf = Buffer.alloc(21);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_SCROLL_EVENT, off); off += 1;
  buf.writeUInt32BE(Math.round(opts.x), off); off += 4;
  buf.writeUInt32BE(Math.round(opts.y), off); off += 4;
  buf.writeUInt16BE(opts.screenWidth, off); off += 2;
  buf.writeUInt16BE(opts.screenHeight, off); off += 2;
  buf.writeInt16BE(clamp16(opts.hscroll), off); off += 2;
  buf.writeInt16BE(clamp16(opts.vscroll), off); off += 2;
  buf.writeUInt32BE(0, off);
  return buf;
}

function clamp16(value: number): number {
  const scaled = Math.round(value * 0x7fff);
  return Math.max(-0x8000, Math.min(0x7fff, scaled));
}

/**
 * Ask the server to restart capture/encoding, which makes it emit a fresh
 * config packet and key frame immediately instead of at the next scheduled
 * I-frame (up to 10s away). Used to recover after dropping frames.
 */
export function resetVideo(): Buffer {
  return Buffer.from([TYPE_RESET_VIDEO]);
}

/**
 * Back if the screen is on, otherwise wake it — scrcpy's right-click.
 * 1 type + 1 action; callers send DOWN then UP.
 */
export function backOrScreenOn(action: number): Buffer {
  return Buffer.from([TYPE_BACK_OR_SCREEN_ON, action]);
}

/** Ask the device to (optionally copy/cut, then) report its clipboard. */
export function getClipboard(copyKey: number = COPY_KEY_NONE): Buffer {
  return Buffer.from([TYPE_GET_CLIPBOARD, copyKey]);
}

/**
 * Set the device clipboard, and optionally paste it into the focused field.
 * 1 type + 8 sequence + 1 paste + 4 length + text. A non-zero sequence makes
 * the device answer with ACK_CLIPBOARD once the clipboard is actually set.
 */
export function setClipboard(text: string, paste: boolean, sequence: bigint = 0n): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeUInt8(TYPE_SET_CLIPBOARD, 0);
  buf.writeBigUInt64BE(sequence, 1);
  buf.writeUInt8(paste ? 1 : 0, 9);
  buf.writeUInt32BE(payload.length, 10);
  payload.copy(buf, 14);
  return buf;
}

/**
 * Turn the device's physical display off (or back on) while mirroring
 * continues — the stream is captured from the virtual display regardless.
 */
export function setDisplayPower(on: boolean): Buffer {
  return Buffer.from([TYPE_SET_DISPLAY_POWER, on ? 1 : 0]);
}

export function rotateDevice(): Buffer {
  return Buffer.from([TYPE_ROTATE_DEVICE]);
}

export function expandNotificationPanel(): Buffer {
  return Buffer.from([TYPE_EXPAND_NOTIFICATION_PANEL]);
}

export function expandSettingsPanel(): Buffer {
  return Buffer.from([TYPE_EXPAND_SETTINGS_PANEL]);
}

export function collapsePanels(): Buffer {
  return Buffer.from([TYPE_COLLAPSE_PANELS]);
}

// ------------------------------------------------------------ device -> host

export const DEVICE_MSG_CLIPBOARD = 0;
export const DEVICE_MSG_ACK_CLIPBOARD = 1;
export const DEVICE_MSG_UHID_OUTPUT = 2;

export type DeviceMessage =
  | { type: 'clipboard'; text: string }
  | { type: 'ackClipboard'; sequence: bigint };

/**
 * Parse as many complete device messages as `buffer` holds. Returns them plus
 * the unconsumed tail, which the caller keeps for the next chunk.
 *
 * Throws on an unknown type: the stream has no framing beyond per-type
 * layouts, so after one unknown byte every later offset would be garbage.
 */
export function parseDeviceMessages(buffer: Buffer): {
  messages: DeviceMessage[];
  rest: Buffer;
} {
  const messages: DeviceMessage[] = [];
  let off = 0;
  for (;;) {
    if (buffer.length - off < 1) break;
    const type = buffer.readUInt8(off);
    if (type === DEVICE_MSG_CLIPBOARD) {
      if (buffer.length - off < 5) break;
      const len = buffer.readUInt32BE(off + 1);
      if (buffer.length - off < 5 + len) break;
      messages.push({
        type: 'clipboard',
        text: buffer.subarray(off + 5, off + 5 + len).toString('utf8'),
      });
      off += 5 + len;
    } else if (type === DEVICE_MSG_ACK_CLIPBOARD) {
      if (buffer.length - off < 9) break;
      messages.push({ type: 'ackClipboard', sequence: buffer.readBigUInt64BE(off + 1) });
      off += 9;
    } else if (type === DEVICE_MSG_UHID_OUTPUT) {
      // 1 type + 2 id + 2 size + data. We never create UHID devices, but skip
      // it correctly rather than desync if the server ever sends one.
      if (buffer.length - off < 5) break;
      const size = buffer.readUInt16BE(off + 3);
      if (buffer.length - off < 5 + size) break;
      off += 5 + size;
    } else {
      throw new Error(`unknown device message type ${type}`);
    }
  }
  return { messages, rest: buffer.subarray(off) };
}
