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
const POINTER_ID_GENERIC_FINGER = 0xfffffffffffffffen; // -2

export function touchEvent(opts: {
  action: number;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
  pressure?: number;
}): Buffer {
  // 1 type + 1 action + 8 pointerId + 12 position + 2 pressure
  // + 4 actionButton + 4 buttons = 32
  const buf = Buffer.alloc(32);
  let off = 0;
  buf.writeUInt8(TYPE_INJECT_TOUCH_EVENT, off); off += 1;
  buf.writeUInt8(opts.action, off); off += 1;
  buf.writeBigUInt64BE(POINTER_ID_GENERIC_FINGER, off); off += 8;
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
