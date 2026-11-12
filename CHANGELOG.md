# Changelog

## 0.1.0

### New

- **Type with your keyboard.** Click the mirrored screen and type into any app,
  including accented and non-Latin text. Shortcuts like Ctrl+A work too.
- **Copy and paste between your computer and the phone.** Cmd/Ctrl+C copies the
  phone's selection, Cmd/Ctrl+V pastes your clipboard on the phone, and anything
  you copy on the phone reaches your computer automatically.
- **Mouse shortcuts.** Right-click goes back (or wakes the screen), middle-click
  goes home, and Alt/Option+drag pinches to zoom.
- **More toolbar buttons.** Notifications, rotate, and turning the phone's own
  screen off while you keep using it in VS Code.
- **Screenshots and screen recordings**, saved wherever you choose. Also
  available from the top right of the tab.
- **Install apps and send files.** Right-click an `.apk` or any file in the
  Explorer, or use the commands.
- **Sound** from the phone (Android 11 and later), with the new
  `deviceMirror.audio` setting.
- **Several phones at once**, each in its own tab.
- **Android Devices list** in the Explorer sidebar, and the mirrored phone's name
  in the status bar.
- **Wi-Fi.** Pair with a code, connect by address, or switch a USB phone to Wi-Fi.
- **Reconnects by itself** when the cable is bumped or the phone briefly drops
  off, with a Reconnect button if it can't.
- **New settings:** `deviceMirror.videoBitRate`, `deviceMirror.audio` and
  `deviceMirror.stayAwake`. Changing a setting while mirroring offers a restart.

### Fixed

- **Security:** other programs and web pages on your computer could connect to
  the mirror, watch the screen and send taps. Only the mirror tab can now.
- **Stop Mirroring** closed whatever editor had focus, which could be your code.
  It now closes only the mirror.
- adb is now found on Windows, and a clear message explains what to do when it
  can't be found.
- Mirroring a second phone, or reloading the window, no longer leaves old
  connections behind or clashes with them.
- The picture recovers by itself instead of freezing when it falls behind.
- Scrolling with a mouse wheel moves a sensible distance on every system, and
  pen pressure is passed through.
- Wi-Fi errors now say when the computer can't reach the phone. A failed switch
  to Wi-Fi puts the phone back in USB mode.

### Removed

- The `deviceMirror.scrcpyVersion` setting. The extension now always uses the
  scrcpy version it was built for and checks it before starting. You can delete
  the setting from your settings file if you had set it.

## 0.0.1

- First release: mirror a USB-connected Android phone in a VS Code tab, with
  touch, scrolling and the Back, Home, Recents, volume and power buttons.
