# Dynamic Android Analysis

Command-first reference for the static→dynamic loop added to `android-mcp`.
Companion to `skills/android-reverse-engineering/SKILL.md`.

## Setup

Dynamic tooling is vendored by `make setup`:

- frida-server (x86_64 + arm64, 17.24.3) under `.toolchain/frida/`
- Python venv with frida-tools 14.11.0 + mitmproxy 12.3.1 under `.toolchain/python-venv/`
- `make doctor` reports `frida`, `frida-ps`, `mitmdump`, `python3`, and frida-server presence

Host prerequisites: `openssl` on `PATH` (used by `net_capture` to derive the Android
CA-store subject hash). Requires a rootable system image (`google_apis`, not `default`)
and KVM on x86_64 hosts.

`frida_ps`, `frida_hook`, and `frida_trace_methods` all provision frida-server on
demand (`adb root`, ABI-matched push, start). A non-rootable image or unsupported ABI
fails with an explicit error before the hook runs.


## Tool reference

| Tool | Purpose |
|---|---|
| `adb_shell` | Raw shell passthrough (no blocklist; timeout only) |
| `adb_logcat` | Clear, wait, dump, regex-filter |
| `runtime_dump` | dumpsys: activity/service/package/meminfo |
| `frida_ps` | Process list via frida-server |
| `frida_hook` | Spawn/attach with inline or file script |
| `frida_trace_methods` | Trace all overloads of a class's methods |
| `net_capture` | Single-session mitmproxy capture (start/stop) |

### adb_shell
`{ deviceId?, command, timeoutSec? (default 60, max 600) }`

### adb_logcat
`{ deviceId?, tag?, pattern?, durationSec? (default 10, max 86400), clear? (default true) }`

### runtime_dump
`{ deviceId?, kind: activity|service|package|meminfo, packageName? }`

### frida_ps
`{ deviceId? }`

### frida_hook
`{ packageName, deviceId?, script?, scriptPath?, spawn? (default true), durationSec? (default 30, max 86400) }`

### frida_trace_methods
`{ packageName, className, methodRegex? (default ".*"), deviceId?, durationSec? (default 30, max 86400) }`

### net_capture
`{ action: start|stop, deviceId?, port? (default 8080), durationSec? (default 30, max 86400) }`

### HTTPS interception caveat (API 34+)

`net_capture` tries to install the mitmproxy CA into the system store via
`adb remount`. On Android 14+ (API 34+) that path is frequently blocked: the system
partition is not remountable, and Android may ignore CA files added to
`/system/etc/security/cacerts` at runtime. Independently, apps with
`targetSdk >= 24` do **not** trust user-installed CAs by default.

So do not assume that pushing the CA or trusting a user certificate makes HTTPS
interception work on modern images. Depending on the target you may need an
APEX/Conscrypt overlay, a Magisk module that mounts a system CA store, or an
in-process unpinning hook (`frida-scripts/ssl-unpin.js`). Without a trusted CA,
`net_capture` may still record cleartext HTTP and connection metadata, but
decrypted HTTPS bodies will be missing.

## Workflows

1. Analyze unknown APK — Phase 1 static, then `frida_trace_methods` + `adb_logcat`.
2. Trace API + crypto secrets — `frida_hook` with `crypto-trace.js`, then `net_capture`.
3. Bypass root/SSL — `frida_hook` with `root-bypass.js`/`ssl-unpin.js`, verify via logcat/HAR.
4. Compare two builds — run 1-3 on each, diff HAR + hook logs.

## Troubleshooting

See `docs/troubleshooting.md` (dynamic rows appended).
