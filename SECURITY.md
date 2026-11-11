# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately instead: use **Report a vulnerability** on the repository's Security tab, or, if that is not available, write to the e-mail address in the [README](README.md#contributors). Steps to reproduce and the affected version help a lot.

Fixes go into the next release. Only the latest release is supported.

## How the app is protected

LargeFileBuster has to read the whole file system, and it can ask Windows Explorer to reveal any file. The design goal is that only the app's own UI can use these abilities.

**The UI cannot be replaced or extended**

- The renderer is sandboxed, context-isolated and has no Node.js access. The only bridge to the main process is the small `window.lfb` API in [`src/preload/preload.ts`](src/preload/preload.ts).
- The UI is served from a private `app://lfb/` origin instead of `file://`. The protocol handler answers from a fixed list of the bundled files, so no request can reach anything else on disk.
- Every response carries a strict Content-Security-Policy: no inline script or style, no `eval`, no network, no framing.
- The window cannot navigate away from the app, cannot open other windows and cannot embed `<webview>`.
- All permission requests (camera, microphone, location, notifications, USB, …) are denied.
- Network requests of the app's browser session are blocked. The app works offline and has no update check or telemetry.

**The main process does not trust what it receives**

- IPC is only answered for the top-level frame of the app's own origin ([`src/main/security.ts`](src/main/security.ts)).
- Every IPC argument is validated ([`src/main/validate.ts`](src/main/validate.ts)). Paths must be absolute drive or UNC paths; relative paths and Windows device namespaces (`\\.\`, `\\?\`) are rejected.
- Scanning and listing never follow symbolic links or junctions.
- Values from the UI reach SQL only as bound parameters.

**A release build cannot be repurposed**

- The Electron fuses are set at packaging time: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` are ignored, and the app code is only loaded from `app.asar`, whose integrity is checked on start.
- Development mode (UI loaded from a local dev server) is only possible in an unpackaged checkout, never in an installed app.
- The SQLite WebAssembly file is loaded from the app's own resources, never from the current working directory.

These points are covered by regression tests in [`test/security.spec.ts`](test/security.spec.ts), and the packaged app is checked by [`scripts/smoke-packaged.mjs`](scripts/smoke-packaged.mjs) in CI.

## Build and release pipeline

- Dependencies are locked with integrity hashes (`package-lock.json`), CI installs with `npm ci`.
- GitHub Actions are pinned to full commit hashes.
- The job that builds and tests has a read-only token and keeps no git credentials. A separate job with write access publishes the release; it installs nothing from npm.
- The publish step verifies that the installer matches the checksum recorded in `latest.yml`, and it never replaces a file of an already published release.

## Known limitations

- **The installer is not code-signed.** Windows SmartScreen will warn on first start. To verify a download, compare its SHA-256 (`Get-FileHash .\LargeFileBuster-Setup-x.y.z.exe`) with the digest GitHub shows next to the file on the release page.
- **Developer Tools are available** (View → Toggle Developer Tools). Code pasted into the console runs with the UI's access to the file system API. Do not paste code you do not understand.
- **The scan database is not encrypted.** `%APPDATA%\largefilebuster\data\lfb.sqlite` contains the names, sizes and dates of everything that was scanned, readable by anyone with access to your Windows profile. File contents are never read or stored.
- Someone who can already run programs under your Windows account is outside what the app can defend against.
