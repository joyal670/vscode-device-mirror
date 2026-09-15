# scrcpy-server

The `scrcpy` backend needs Genymobile's server binary dropped in this folder as
`scrcpy-server.jar` (it is git-ignored, and not redistributed here).

```bash
curl -L -o scrcpy-server.jar \
  https://github.com/Genymobile/scrcpy/releases/download/v3.1/scrcpy-server-v3.1
```

**The version must match `deviceMirror.scrcpyVersion` exactly.** The server
checks the version string it is launched with and refuses to run on a mismatch,
and the `key=value` argument format changed shape across 1.x → 2.x → 3.x. If you
fetch a different release, update the setting to match.

scrcpy-server is Apache-2.0. If you ever publish this extension, ship the
upstream LICENSE/NOTICE alongside the jar.
