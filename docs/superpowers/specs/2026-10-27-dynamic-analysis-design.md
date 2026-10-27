# Design: Dynamic Android Analysis — REA skill × Emulator

**Date:** 2026-10-27
**Status:** Draft for approval
**Repo:** `/home/kali/android-mcp` (Open-Droid)

---

## Intent and why

Today `android-reverse-engineering` is static-only: JADX/apktool decompilation,
manifest inspection, version diffing. Static analysis *guesses*. With the
emulator now bootable (KVM host or Docker), the APK can be **run and observed**,
which converts guesses into ground truth: which methods actually fire, what
keys/strings cross the crypto boundary, what API traffic leaves the device,
what integrity checks reject the environment.

Goal: make the REA skill loop like a senior reverse engineer does —
**static trace → dynamic hypothesis → runtime confirm → refined static analysis**.

## Approaches considered

| | A. Behavioral only | B. Behavioral + network | **C. Full dynamic (picked)** |
|---|---|---|---|
| Adds | logcat/dumpsys/screenshots | A + mitmproxy HAR capture | B + Frida hooking |
| Method-level visibility | no | no | **yes** |
| Beats packers/DexGuard | no | partial | **yes** (runtime class dump) |
| New vendored deps | 0 | mitmproxy (~40 MB) | + frida-server + frida CLI (~60 MB) |
| Rootable image needed | no | yes (CA cert) | yes |

User picked **C**. Primary use: **security research / analysis of third-party
APKs** (Kali host, security-oriented account), with own-app debugging as
secondary benefit.

## Goals

1. New MCP tools (thin CLI wrappers, per repo conventions) covering the
   behavioral, network, and instrumentation layers.
2. Vendored, offline-first: frida-server + frida CLI + mitmproxy land in
   `.toolchain/` during `make setup`; nothing downloaded later.
3. A curated Frida script library shipped with the repo (`frida-scripts/`):
   the 80% cases as ready-to-run hooks.
4. `android-reverse-engineering` skill rewritten around the
   static→dynamic loop, with concrete workflows and tool recipes.
5. Works on both x86_64 and arm64 hosts (arch-aware vendoring, mirroring
   how `setup.sh` already picks system-image ABI).

## Non-goals

- No GUI/dashboard — evidence flows back through MCP tool returns
  (text, JSON, HAR paths, screenshots).
- No deobfuscation AI magic — the skill guides *method*, not auto-magic.
- No support for Play Store images (`playstore` system images cannot be
  rooted; `google_apis` images are the supported baseline — already what
  `setup.sh` installs).
- No magic bypass *development* framework — shipped scripts cover common
  known techniques; custom hooks go through `frida_hook` with user scripts.

## Anti-goals (failure even if it works)

- Tool calls that hang forever (every tool must have explicit timeouts).
- A `make setup` that needs internet *after* the first run.
- Frida tooling that only works on one architecture.

## Constraints

- MCP tools are thin wrappers over CLIs (repo rule). Frida host tooling is
  the `frida` CLI in a vendored Python venv — not a native Node binding.
- Emulator binaries require KVM on x86_64; existing KVM preflight/doctor
  flow already covers this and extends unchanged.
- Frida server binary arch must match the booted AVD ABI
  (x86_64 ↔ arm64-v8a), checked at tool-call time, with a clear error.
- `google_apis` images allow `adb root` — required to push/run frida-server
  and install the mitmproxy CA cert. Tooling verifies and instructs.

## Decided: the parts

### 1. New MCP tools (13 → 20)

| Tool | Wraps | Purpose |
|---|---|---|
| `adb_logcat` | `adb logcat -d/-T` | Capture filtered device log (tag/pattern/duration), returns text |
| `adb_shell` | `adb shell` | General **raw passthrough** to the device shell (user decision: no blocklist, trusted-project tool; explicit timeout only). Documented in README as a high-trust tool |
| `runtime_dump` | `dumpsys` | Structured probes: `activity`, `service`, `meminfo <pkg>`, `package <pkg>` |
| `frida_ps` | `frida-ps -U` | List processes on device/AVD |
| `frida_hook` | `frida -U -f/-n <pkg> -l <script>` | Spawn or attach + run a JS hook script (inline or file path), duration-limited, returns script console output |
| `frida_trace_methods` | `frida -U -l <built-in trace>` | Parametrized method tracing: class + regex of methods, dump args/return values |
| `net_capture` | `mitmdump` | **Single-session** (user decision): start/stop mitmproxy on host with a device profile (proxy set via adb, CA cert auto-installed after `adb root`); second `start` returns "busy"; returns HAR path |

Common behavior: `deviceId` optional (auto-pick when one device), explicit
timeouts, explicit arch/device checks with actionable errors (same style as
existing tools). `frida-server` is pushed and started per-boot by the
frida tools (idempotent): `adb root` → push → chmod → nohup run.

### 2. Vendoring (`setup.sh`, `versions.env`)

- `FRIDA_VERSION` pinned (e.g. 17.x — latest stable at implementation time).
  Download `frida-server-<ver>-android-{x86_64,arm64}.xz` from
  frida/frida GitHub releases into `.toolchain/frida/` (both arches, so any
  AVD works).
- Python venv at `.toolchain/python-venv/` containing `frida-tools` and
  `mitmproxy` (pinned versions in `versions.env`). venv creation requires
  `python3` on the host — added to setup preflight + doctor.
- `env.sh` extends PATH with the venv bin dir.
- Make targets: `make doctor` gains checks: frida CLI, frida-server file,
  mitmproxy, python3, venv health.

### 3. Frida script library (`frida-scripts/`)

Shipped, versioned, documented in the skill:

- `class-dump.js` — enumerate loaded classes matching a regex (runtime
  truth for packed/hidden classes).
- `crypto-trace.js` — hook `javax.crypto`, `okio`, Conscrypt: dump
  algorithm, key bytes, IV, plaintext/ciphertext on the wire.
- `ssl-unpin.js` — common SSL-pinning bypass (okhttp/TrustManager/Conscrypt/
  flutter patterns).
- `root-bypass.js` — hide root indicators (File checks, `su`, Magisk
  manager queries, SafetyNet-legacy patterns).
- `api-trace.js` — hook OkHttp/URL/Socket layers, log request lines and
  hosts at the app layer (complements mitmproxy for TLS-pinned apps).
- `hook-method.js` — generic: `class.name#method(regex)` → dump args +
  return value; the "recon" hook used to confirm static findings.

### 4. Skill rewrite (`skills/android-reverse-engineering/SKILL.md`)

Same file (name/description stay), rewritten to three phases:

- **Phase 1 — Static recon** (existing REA MCP tools: package inspect,
  class/method inspect, reference trace, app graph).
- **Phase 2 — Dynamic observation** (boot → install → launch → logcat/
  dumpsys/screenshots → mitmproxy HAR → `inspect_web_network_capture`).
- **Phase 3 — Instrumentation loop** (frida_ps → class-dump/crypto-trace/
  hook-method → feed confirmed facts back into static trace).

Plus four step-by-step workflows: "analyze unknown APK",
"trace API + crypto secrets", "bypass root/SSL checks",
"compare two builds dynamically". Each names exact MCP tool calls.

Also updated: `skills/reverse-engineer-anything` gets one paragraph
pointing at the Android dynamic workflow; `start-here` mentions the
capability for the review/investigation phases.

### 5. Docs

- `docs/dynamic-analysis.md` — the full guide (setup, KVM, workflows,
  troubleshooting: frida-server arch mismatch, `adb root` failures,
  CA cert issues, proxy resets).
- `README.md` — feature list + MCP tool table updated (20 tools).
- `docs/troubleshooting.md` — new rows for the above errors.

### 6. Instrumented demo app (`examples/vuln-app`) — user decision

A deliberately vulnerable practice target so the integration test asserts real
behavior and users can exercise every workflow safely:

- Hardcoded AES key + AES/CBC encryption path through `javax.crypto` (target
  for `crypto-trace.js`).
- OkHttp request with certificate pinning (target for `net_capture` +
  `ssl-unpin.js`).
- Fake root-detection routine (file checks for `su`, `magisk` — target for
  `root-bypass.js`).
- A debug-gated "secret" activity readable only after the root check passes
  (end-to-end success signal for the full loop).

Clearly labeled as a test/demo target only; never published to any store.

### 7. Tests

- Smoke test updated to the new tool count (all tools registered).
- Unit-ish test: schema validation + arch-check logic for frida helpers.
- Integration test script (`test/integration-dynamic.sh`, manual/local only —
  GitHub runners lack KVM): boots AVD, installs example app, exercises
  logcat/dumpsys/frida-ps/frida-hook/crypto-trace/net_capture on the
  shipped example app; asserted outputs.

## Left to the builder

- Exact pinned versions (frida, frida-tools, mitmproxy) resolved at
  implementation time and written into `versions.env`.
- Frida CLI invocation details (spawn vs attach flags, script encoding,
  output capture) inside the thin wrapper.
- mitmproxy HAR export invocation (`mitmdump --set hardump=...`).
- CA cert generation/push plumbing (mitmproxy generates a CA at first run;
  tools manage install on `google_apis` images).
- Error-message wording consistent with existing tools.

## Settled by the builder (minor calls — reviewer-verified)

- **Fix live setup.sh bug:** `SYSTEM_IMAGE` references `$IMG_ABI` before it is
  defined (setup.sh:71 vs 75–82) — fresh `make setup` aborts under `set -u`.
  Move the arch block above line 71 as part of §2.
- **frida asset names:** GitHub releases ship `frida-server-<ver>-android-x86_64.xz`
  and `frida-server-<ver>-android-arm64.xz` (not `arm64-v8a`); repo keeps ABI
  names and maps to asset names in setup.
- **`default`-image fallback breaks `adb root`:** setup warns when only a
  non-rootable fallback image exists; frida/net tools error at call time with
  an actionable message (established optional-CLI pattern).
- **frida attach syntax:** attach by positional target (`frida -U <name>`),
  not `-n`; spawn via `-f`. Output captured to a temp file, duration-capped.
- **`net_capture` implementation:** detached `mitmdump` + pidfile (same
  pattern as `emulator_boot`); HAR written at stop via `--set hardump=`.
- **CA cert plumbing:** mitmproxy CA generated at first run in `~/.mitmproxy`;
  `adb root` + remount + push into the system store (google_apis images).
- **Smoke test:** tightened to assert exactly 20 registered tools + per-name
  checks (current assertion is only `>= 10`).
- **Pins:** `FRIDA_VERSION=17.24.3` (verified current at design time), matching
  frida-tools, mitmproxy 11.x — written into `versions.env`.
- **`frida-scripts/`** lives at repo root (shipped/versioned, not gitignored
  `.toolchain/`); all six scripts are single-file, dependency-free JS.

## Risks

- **frida-server release assets move** → pinned versions + doctor check;
  setup failure is a warning, not fatal (mirrors optional-CLI pattern),
  but then frida tools error clearly at call time.
- **python3 missing on host** → preflight + doctor + troubleshooting row.
- **Frida detection by target apps** → documented in the skill as a known
  limitation; obfuscation/detection is an arms race, scripts cover common
  cases only.
