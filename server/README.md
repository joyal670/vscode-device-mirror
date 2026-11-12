# scrcpy-server

The `scrcpy` backend needs Genymobile's server binary in this folder as
`scrcpy-server.jar` (it is git-ignored, and not redistributed here). Fetch it
with:

```bash
npm run fetch-server
```

That downloads the official
[v3.1 release](https://github.com/Genymobile/scrcpy/releases/tag/v3.1) and
saves it only if its SHA-256 matches.

**The extension is pinned to scrcpy 3.1.** The server refuses to run unless it
is launched with its exact version string, and the `key=value` argument format
and the control protocol change between releases. The extension checks the
jar's SHA-256 before starting a session and says so if it is missing or a
different release. To move to another release, update `src/server.ts`,
`scripts/fetch-server.js` and the protocol code together.

scrcpy-server is Apache-2.0. If you ever publish this extension, ship the
upstream LICENSE/NOTICE alongside the jar.
