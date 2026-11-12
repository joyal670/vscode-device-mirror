# Device Mirror

See and control your Android phone inside VS Code. The phone's screen opens in
an editor tab next to your code, and you use it with your mouse and keyboard.

## Why use it

- **Stay in your editor.** Test your app beside the code you're changing,
  without switching to another window or reaching for the phone.
- **Nothing to install on the phone.** It uses USB debugging, which Android
  already has. Nothing stays on the phone after you stop.
- **Fast and smooth.** A live video stream (up to 30 fps by default), not a
  slideshow of screenshots.
- **Use your real keyboard.** Type into any app, including accented and
  non-Latin text, and copy and paste between your computer and the phone.
- **Handy tools built in.** Screenshots, screen recordings, installing APKs and
  sending files, from the toolbar or a right-click.
- **More than one phone.** Mirror several phones at once, over USB or Wi-Fi.
- **Free and open source** (MIT).

## What you need

- **VS Code 1.84 or later**, or another editor that installs extensions from
  Open VSX.
- **adb** (Android SDK Platform-Tools). If you have Android Studio, you already
  have it. Otherwise download
  [Platform-Tools](https://developer.android.com/tools/releases/platform-tools).
- **An Android phone or tablet running Android 5.0 or later.** Sound needs
  Android 11 or later.

## Getting started

1. **Turn on USB debugging on the phone.** Open **Settings › About phone** and
   tap **Build number** seven times to unlock Developer options. Then turn on
   **Settings › Developer options › USB debugging**. (The exact menu names
   vary a little between phone makers.)
2. **Plug the phone into your computer.** When the phone asks
   **Allow USB debugging?**, tap **Allow**.
3. **Start mirroring.** Open the Command Palette (**Cmd+Shift+P** on Mac,
   **Ctrl+Shift+P** on Windows and Linux) and run
   **Device Mirror: Start Mirroring**. If more than one phone is connected,
   pick one from the list.

The phone appears in a new tab. You can also start from the **Android Devices**
list in the Explorer sidebar.

To stop, close the tab or run **Device Mirror: Stop Mirroring**.

## Using the phone

| To do this | Do this |
|---|---|
| Tap | Click |
| Swipe or drag | Click and drag |
| Scroll | Mouse wheel or trackpad |
| Go back | Right-click (also wakes the screen) |
| Go home | Middle-click |
| Pinch to zoom | Hold **Alt** (**Option** on Mac) and drag |
| Type | Click the screen, then type on your keyboard |
| Copy from the phone | Select text on the phone, then **Cmd/Ctrl+C** |
| Paste to the phone | **Cmd/Ctrl+V** |

The toolbar under the screen has buttons for:
- Recent apps, Home and Back
- Notifications
- Rotate
- Turning the phone's own screen off while you keep using it here
- Screenshot and screen recording
- Volume and power

## More features

- **Screenshots and recordings.** Use the toolbar or the buttons at the top
  right of the tab. Screenshots are full-resolution PNG images. Recordings are
  MP4 videos of up to 3 minutes. Both are saved wherever you choose.
- **Install an app or send a file.** Right-click an `.apk` file in the Explorer
  and choose **Install APK on Device**. Right-click any other file and choose
  **Push File to Device**. Files arrive in the phone's **Download** folder.
- **Sound.** Turn on the `deviceMirror.audio` setting, then click the mirrored
  screen once to start playback.
- **Several phones.** Start mirroring again and pick another phone. Each one
  gets its own tab.
- **Copy from the phone automatically.** Anything you copy on the phone also
  lands on your computer's clipboard.
- **Reconnects by itself** if the cable is bumped or the phone briefly drops
  off.

## Over Wi-Fi

Your computer and the phone must be on the same Wi-Fi network.

- **Phone plugged in by USB:** run **Device Mirror: Switch USB Device to
  Wi-Fi**, then unplug the cable.
- **No cable (Android 11 and later):** on the phone, open **Developer options ›
  Wireless debugging › Pair device with pairing code**. Then run **Device
  Mirror: Pair Device over Wi-Fi** and type in what the phone shows.
- **Already set up for Wi-Fi:** run **Device Mirror: Connect to Device over
  Wi-Fi** and enter the phone's address, for example `192.168.1.20:5555`.

Some routers stop devices on the same Wi-Fi from talking to each other ("client
isolation" or "AP isolation"). If Wi-Fi connections keep failing, check your
router settings or use a cable.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `deviceMirror.maxSize` | `1024` | Longest side of the video, in pixels. Lower is faster. |
| `deviceMirror.maxFps` | `30` | Maximum frames per second. |
| `deviceMirror.videoBitRate` | `0` | Video quality in bits per second; `0` uses the default (8 Mbps). |
| `deviceMirror.audio` | off | Play the phone's sound (Android 11 and later). |
| `deviceMirror.stayAwake` | off | Keep the phone awake while mirroring over USB. |
| `deviceMirror.mode` | `scrcpy` | `screencap` is a slow, view-only fallback that needs nothing but adb. |
| `deviceMirror.adbPath` | (auto) | Full path to adb, if it can't be found automatically. |

When you change a setting while mirroring, you're offered a restart to apply
it.

## Troubleshooting

- **"adb not found".** Install Platform-Tools (see "What you need"), or set
  `deviceMirror.adbPath` to the full path of `adb` (`adb.exe` on Windows).
- **The phone isn't listed, or shows as unauthorized.** Unplug and replug it,
  unlock it, and tap **Allow** on the USB debugging prompt. Some cables only
  charge; try another.
- **Some apps show a black screen.** Banking and video apps often block screen
  capture. This is the app's choice and can't be bypassed.
- **No sound.** Sound needs Android 11 or later, the `deviceMirror.audio`
  setting turned on, and one click on the mirrored screen.
- **Wi-Fi won't connect.** See the note on client isolation under "Over Wi-Fi".

## Good to know

- Android only. iPhones and iPads aren't supported.
- You can't drag files onto the mirrored screen. Right-click them in the
  Explorer instead.

## Credits

Built on [scrcpy](https://github.com/Genymobile/scrcpy) by Genymobile
(Apache-2.0), whose small server runs on the phone only while you mirror.
Device Mirror is released under the MIT license.

Want to work on the extension? See [DEVELOPMENT.md](DEVELOPMENT.md).
