---
name: android-reverse-engineering
description: Reverse engineer Android APKs/AABs — static decompilation (JADX/apktool/REA) plus dynamic analysis on a live emulator: Frida hooking, crypto/network tracing, root/SSL bypass, runtime observation
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: android
  borrows: reverse-engineer-anything
---
# Android Reverse Engineering (static → dynamic)

You are analyzing an Android app. Work in three phases, escalating only when
static analysis stops yielding answers. Every dynamic step runs on the
emulator via the MCP tools below — never on a production device.

## Phase 1 — Static (no device needed)

- Decompile with `jadx` (Java/Kotlin) and `apktool` (resources/smali).
- Inspect `AndroidManifest.xml`: package, permissions, components, intents, exported flags.
- Read smali for the classes the manifest points at; search strings for URLs, keys, endpoints.
- Use the `rea` MCP (Ghidra/JADX/binwalk) for native `.so` and packed assets.
- Identify: entry activities, crypto routines, network clients, root/SSL checks, pinning.

## Phase 2 — Dynamic (emulator + Frida)

Boot an AVD (`emulator_boot`, `adb wait-for-device`), install the APK
(`adb_install`), then:

- `adb_shell` — raw passthrough for `pm list packages`, `dumpsys`, `am start`, etc.
- `adb_logcat` — capture tagged logs (clear, wait, dump, regex-filter).
- `runtime_dump` — activity/service/package/meminfo probes.
- `frida_ps` — confirm frida-server + process list.
- `frida_hook` — spawn/attach with an inline or file script. Embed `CONFIG`:
  ```js
  var CONFIG = { className: "com.example.app.Crypto", methodRegex: ".*", maxLen: 256 };
  // ... paste frida-scripts/hook-method.js ...
  ```
- `frida_trace_methods` — shortcut: pass `packageName`, `className`, `methodRegex`.
- Curated scripts in `frida-scripts/`: `class-dump.js`, `crypto-trace.js`,
  `ssl-unpin.js`, `root-bypass.js`, `api-trace.js`, `hook-method.js`. Each reads
  a `CONFIG` global and logs lines prefixed `[open-droid]`.

## Phase 3 — Network (mitmproxy)

- `net_capture start` (port default 8080) — roots device, pushes CA, sets proxy,
  launches mitmdump detached, writes HAR to tmpdir. Auto-stops after `durationSec`.
- `net_capture stop` — SIGTERM, waits for HAR, clears proxy, returns HAR path.
- Single session: a second `start` while running returns "busy".

## The four workflows

### 1. Analyze an unknown APK
1. Phase 1 static: manifest → components → smali for one entry activity.
2. `frida_trace_methods` on the entry activity's controller class to map the
   call graph at runtime.
3. `adb_logcat` with the app's tag to capture startup flow.

### 2. Trace API + crypto secrets
1. `frida_hook` with `crypto-trace.js` (inline) while exercising the app.
2. `net_capture start` → trigger the network call → `net_capture stop` → parse HAR.
3. Cross-reference HAR bodies with captured key material from the hook output.

### 3. Bypass root / SSL checks
1. `frida_hook` spawn with `root-bypass.js` inline → relaunch → `adb_logcat`
   asserts `SECRET ACCESS GRANTED` (vuln-app).
2. `ssl-unpin.js` for OkHttp/CertificatePinner targets; verify the request
   reaches the server (HAR) instead of failing TLS.

### 4. Compare two builds dynamically
1. Run workflows 1-3 on build A, save HAR + hook logs.
2. Repeat on build B.
3. Diff: new endpoints, changed crypto, added checks.

## Tools (MCP + shell)
- `adb_shell`, `adb_logcat`, `runtime_dump`, `frida_ps`, `frida_hook`,
  `frida_trace_methods`, `net_capture` (7 new).
- `jadx`, `apktool`, `aapt2`, `rea` MCP for static/native.

## When to use me
- Analyzing a third-party or legacy APK.
- Investigating undocumented behavior or security issues.
- Comparing two builds of an app.
- Dynamic tracing of crypto, network, root, or SSL behavior.

## Attribution
Borrows structure and methodology from the `reverse-engineer-anything` skill (rea-agents).
Dynamic layer added by the dynamic-analysis feature (7 new MCP tools).
