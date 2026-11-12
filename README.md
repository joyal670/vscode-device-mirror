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

## Features

- **Mirror and control** with touch, scroll, the full keyboard (including IME
  input such as CJK and accents) and hardware keys. Right-click is Back (or
  wakes the screen), middle-click is Home, **Alt+drag** pinches/rotates around
  the screen centre.
- **Clipboard sync.** Cmd/Ctrl+C in the mirror copies the device selection to
  your clipboard; Cmd/Ctrl+V pastes your clipboard on the device. Anything the
  device copies lands on your clipboard automatically.
- **Toolbar**: Recents, Home, Back, notifications, rotate, turn the device
  screen off while mirroring, screenshot, screen recording, mute, volume, power.
- **Screenshots** (full resolution PNG) and **screen recordings** (MP4 via the
  device's `screenrecord`, up to 3 minutes). Also in the editor title bar.
- **Audio forwarding** (`deviceMirror.audio`, Android 11+). Click the mirror
  once to allow playback.
- **Several devices at once**, one tab each.
- **Android Devices** view in the Explorer: state, connection type, which
  devices are mirrored or recording, and per-device actions.
- **Install APKs and push files**: right-click files in the Explorer, or use
  the commands. Pushed files go to `/sdcard/Download/`.
- **Wi-Fi**: pair with a pairing code (Android 11+), connect by address, or
  switch a USB device to Wi-Fi.
- **Reconnects** by itself when a device drops and comes back; settings
  changes offer a restart.

## Running it

```bash
npm install
npm run fetch-server   # downloads scrcpy-server 3.1 and checks its SHA-256
npm run compile
```

Then press **F5** to launch the Extension Development Host, and run
**Device Mirror: Start Mirroring** from the command palette.

`npm test` compiles and runs the unit tests (Node's built-in test runner, no
device needed): the control-message encoders against the scrcpy 3.1 byte
layouts, the device-message and media-packet parsers, the bridge's access
checks, adb discovery and the server jar check. `npm run lint` runs ESLint over
the extension, the webview script and the build scripts. CI runs both on
Linux, macOS and Windows, then packages the `.vsix` and checks its contents.

The tests don't cover anything that needs VS Code or a phone (the panel, the
commands, the webview's decoding and input); those were checked by driving a
real VS Code window against real devices.

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

- **Version lock.** The scrcpy server argument format is version-specific, so
  the extension is pinned to scrcpy 3.1 (`src/server.ts`) and checks the jar's
  SHA-256 before starting. Bumping it means updating that file,
  `scripts/fetch-server.js` and the protocol code together.
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
- **Keyboard focus.** Keys go to a hidden `<textarea>`, not the canvas: only an
  editable element gets IME composition and native copy/paste events. Text is
  sent with `INJECT_TEXT`; non-text keys and Ctrl/Alt combinations go as
  keycodes with Android meta state. Cmd shortcuts on macOS are left to VS Code.
- **Command-line length.** Some devices abort `app_process` natively ("stack
  corruption detected") when the `adb shell` command passes ~300 characters —
  measured on a Samsung SM-A145P / Android 15: 296 ran, 312 crashed.
  `scrcpy.ts` therefore passes only options that differ from the server's
  defaults. Keep it that way when adding options.
- **H.264 only, raw audio.** VS Code's Electron exposes no WebCodecs decoder
  for H.265, AV1, VP9, Opus or AAC (all report unsupported in Electron 43), so
  video is always H.264 and audio is requested as raw PCM
  (`audio_codec=raw`, ~1.5 Mbps) and played with Web Audio.
- **Rotation mid-drag.** If the device rotates while a pointer is down, the
  gesture is released at a remapped position rather than continued. Upstream
  scrcpy lets the drag teleport instead; releasing avoids an accidental fling.

## Not done yet

Drag-and-drop onto the mirror panel (use the Explorer context menu instead):
VS Code only passes drops into a webview while Shift is held, and dropped OS
files arrive without a path, so their bytes would have to be streamed over the
bridge.

## iOS

Not supported and not straightforward. Simulators can be captured with
`xcrun simctl io booted recordVideo`; physical devices need the AVFoundation
screen-capture path over usbmuxd, which means a native macOS helper binary
rather than anything a Node extension can do.
