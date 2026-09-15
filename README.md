# Device Mirror

Mirror and control a connected Android device inside VS Code — the same idea as
Android Studio's built-in device mirroring.

## How it works

Android Studio pushes a native agent to `/data/local/tmp`, runs it over
`adb shell`, and streams H.264 back through an `adb forward` socket while a
second socket carries injected input events. This does the same thing, but uses
scrcpy-server as the on-device agent instead of a hand-written one.

A VS Code webview is a sandboxed Chromium iframe — no `child_process`, no `net`,
no filesystem — so the work is split:

| Side | File | Does |
|---|---|---|
| Extension host (Node) | `src/scrcpy.ts` | push server, `adb forward`, own both sockets, parse the frame stream |
| Extension host (Node) | `src/bridge.ts` | loopback WebSocket carrying frames to the webview |
| Extension host (Node) | `src/control.ts` | encode scrcpy control messages |
| Webview (Chromium) | `media/main.js` | decode H.264 with WebCodecs, draw to canvas, capture input |

Frames travel over a loopback WebSocket rather than `postMessage`, which would
structured-clone every frame through the extension RPC layer.

## Backends

`deviceMirror.mode` picks one:

- **`screencap`** — polls `adb exec-out screencap -p`. ~2fps, view-only, needs
  nothing but adb. Use it to prove the plumbing works before touching a codec.
- **`scrcpy`** — real-time H.264 with touch, scroll, keyboard and hardware keys.
  Requires `server/scrcpy-server.jar` (see `server/README.md`).

## Running it

```bash
npm install
npm run compile
```

Then press **F5** to launch the Extension Development Host, and run
**Device Mirror: Start Mirroring** from the command palette.

## Wire format

Video stream, as parsed in `src/scrcpy.ts`:

```
[1]  dummy 0x00            first socket only — drop it or every offset shifts
[64] device name, NUL-padded
[12] codec id | width | height
repeating:
[8]  pts (bit63 = config packet, bit62 = key frame)
[4]  payload length
[N]  H.264 Annex B
```

Touch control message (32 bytes, `src/control.ts`):

```
u8  type = 2      u8  action        u64 pointer id
u32 x             u32 y             u16 screenW      u16 screenH
u16 pressure      u32 actionButton  u32 buttons
```

`width`/`height` are **not** a scaling hint. Verified against the v3.1 server
bytecode — `PositionMapper.map()` is literally:

```
videoSize.equals(clientScreenSize) ?
    videoToDeviceMatrix.apply(point)   // sizes match -> scale to the device
  : null                               // mismatch    -> event discarded
```

and `Controller.injectTouch` returns silently on null. That is how upstream discards input that raced a
rotation, and it means the only valid coordinate space is the decoded video
frame, *not* the physical display from `wm size` (which differs as soon as
`max_size` downscales). `media/main.js` therefore re-reads the size from every
decoded frame and stamps each event with it; `src/panel.ts` passes it through
untouched.

## Known sharp edges

- **Version lock.** The scrcpy server argument format is version-specific. Pin
  one release and keep `deviceMirror.scrcpyVersion` in sync.
- **CSP.** The webview needs `connect-src ws://127.0.0.1:<port>` and a script
  nonce, both generated in `src/panel.ts`. Without them the bridge fails
  silently.
- **Cleanup.** `ScrcpySession.dispose()` removes the `adb forward` rule. Skip it
  and you accumulate a dead rule per reload.
- **Debugging discarded input.** The discard is logged at **verbose**, not debug:
  `log_level=verbose` then look for `Ignore positional event generated for size
  1080x2408 (current size is 456x1024)`. At `debug` you see nothing at all and
  input just silently does nothing.
- **Finger, not mouse.** `control.ts` stamps `POINTER_ID_GENERIC_FINGER` (-2).
  Using `POINTER_ID_MOUSE` (-1) makes scrcpy inject `SOURCE_MOUSE` /
  `TOOL_TYPE_MOUSE`, which depends on correct button state and is handled
  inconsistently across devices.
- **Dead sockets connect fine.** `adb forward` to a stale `localabstract` name
  still accepts the TCP connection, then closes it. Waiting only for `'connect'`
  hands back a corpse that yields zero frames with no error, so
  `connectVideoWithRetry` waits for the handshake byte instead. Each session also
  generates its own scid so it can never inherit a previous run's socket.
- **Keyboard.** Only printable characters, Backspace and Enter are mapped. A full
  Android keycode table is not included.
- **Rotation mid-drag.** If the device rotates while a pointer is down, the
  gesture is released at a remapped position rather than continued. Upstream
  scrcpy lets the drag teleport instead; releasing avoids an accidental fling.

## Not done yet

Multi-device tabs, clipboard sync, drag-and-drop APK install, audio forwarding,
and a proper status-bar entry point.

## iOS

Not supported and not straightforward. Simulators can be captured with
`xcrun simctl io booted recordVideo`; physical devices need the AVFoundation
screen-capture path over usbmuxd, which means a native macOS helper binary
rather than anything a Node extension can do.
