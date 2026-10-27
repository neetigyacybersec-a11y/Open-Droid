# Dynamic Android Analysis (REA × Emulator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `android-reverse-engineering` a full static→dynamic loop: 7 new MCP tools (13→20), frida-server + frida CLI + mitmproxy vendored offline-first into `.toolchain/`, a shipped Frida script library, an instrumented practice app, and a rewritten skill.

**Architecture:** MCP tools stay thin wrappers over CLIs (repo rule) — Frida tooling via a vendored Python venv's `frida` CLI, network capture via `mitmdump`, device-side frida-server pushed per-boot after `adb root`. A shared helper module (`src/frida.ts`) owns CLI/server resolution and ABI mapping; the six hook scripts are standalone dependency-free JS at repo root. Evidence flows back as tool returns (text/JSON/HAR paths), and the skill orchestrates the loop.

**Tech Stack:** TypeScript MCP server (existing), Python venv (frida-tools, mitmproxy) under `.toolchain/`, Bash setup/doctor scripts, GitHub Actions (build-only app CI; no KVM on runners).

**Spec:** `docs/superpowers/specs/2026-10-27-dynamic-analysis-design.md` (approved). User decisions baked in: `adb_shell` = raw passthrough; `examples/vuln-app` = yes; `net_capture` = single-session.

## Global Constraints

- Offline-first: everything vendored during `make setup`; zero downloads after (spec §Constraints).
- MCP tools are thin CLI wrappers; all `run()` calls carry explicit timeouts (src/tools.ts existing style).
- Arch-aware: x86_64 ↔ arm64-v8a; frida-server ABI must match booted AVD ABI, checked at call time with actionable errors (spec §Constraints).
- `google_apis` images are the rootable baseline; `default` fallback → warn in setup, error at call time (spec §Settled).
- Pins into `versions.env`: `FRIDA_VERSION=17.24.3`; frida-tools + mitmproxy exact pins resolved by the implementer via `pip index versions` / GitHub API at implementation time, written verbatim with a comment naming the source date.
- `frida-scripts/` lives at repo root; six single-file, dependency-free scripts reading a `CONFIG` global (spec §Settled).
- Never commit `.toolchain/`, `node_modules/`, `dist/`, or secrets (AGENTS.md).
- `npm run build && npm test` must pass before every commit that touches `src/`.

## Review Focus

The five failure modes the spec implies that most bite a user, with the test that pins each:

1. **frida-server ABI ≠ AVD ABI** (e.g. arm64 server pushed to x86_64 AVD) → expect a one-line actionable error naming both ABIs, not cryptic frida output. → Task 5 unit test `mapAbiToAsset`.
2. **Non-rootable system image** (`default` fallback installed) → expect error explaining `adb root` impossible + fix pointer, before any frida invocation. → Task 5 unit test `parseBuildType`.
3. **Hung tool calls** (frida session alive forever, logcat follow without end) → expect every tool to return within its declared timeout with whatever was captured. → Task 8 smoke asserts tools/list; Task 10 integration caps every phase with `timeout`.
4. **Second `net_capture start` while a capture runs** → expect a "busy" error naming the pidfile/port, exactly one mitmdump process. → Task 7 unit test `pidRunning`.
5. **Vendored CLI resolution drift** (PATH frida shadows vendored one) → expect the `.toolchain/python-venv/bin/frida` path to win so offline hosts keep working. → Task 5 unit test `resolveFridaCli`.

---

### Task 1: Fix setup.sh arch-block ordering bug + python3 preflight

**Files:**
- Modify: `scripts/setup.sh` (arch block currently AFTER the `SYSTEM_IMAGE=` line that consumes `$IMG_ABI` — moves above it)
- Test: `test/setup-order.test.sh` (new, tiny bash assertion)

**Interfaces:**
- Produces: `IMG_ABI` (`x86_64` | `arm64-v8a`) and `HOST_ARCH` set before any consumer; `SYSTEM_IMAGE="system-images;$ANDROID_PLATFORM;google_apis;$IMG_ABI"` resolved after both exist. Later tasks (Task 2) append vendoring after this block.

- [ ] **Step 1: Write the failing test**

`test/setup-order.test.sh`:

```bash
#!/usr/bin/env bash
# The bug this pins: SYSTEM_IMAGE referenced $IMG_ABI before it was defined.
set -euo pipefail
DEF=$(grep -n 'IMG_ABI=' scripts/setup.sh | head -1 | cut -d: -f1)
USE=$(grep -n 'SYSTEM_IMAGE=' scripts/setup.sh | head -1 | cut -d: -f1)
[ -n "$DEF" ] && [ -n "$USE" ]
if [ "$DEF" -gt "$USE" ]; then echo "FAIL: IMG_ABI defined (line $DEF) after first use (line $USE)"; exit 1; fi
PY=$(grep -cn 'python3' scripts/setup.sh)
[ "$PY" -ge 1 ] || { echo "FAIL: no python3 preflight in setup.sh"; exit 1; }
echo "setup-order test passed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/setup-order.test.sh`
Expected: FAIL ("IMG_ABI defined after first use")

- [ ] **Step 3: Move the arch/KVM block above the license/sdmanager section; add python3 preflight**

Move the `HOST_ARCH`/`IMG_ABI`/KVM-warning block to immediately after the JDK env exports and before any `SYSTEM_IMAGE=` use. Add after the Node check, in the same style:

```bash
if ! command -v python3 >/dev/null 2>&1; then
  log "WARNING: python3 not found. Required for frida/mitmproxy (dynamic analysis). Install: sudo apt install -y python3 python3-venv"
fi
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash -n scripts/setup.sh && bash test/setup-order.test.sh`
Expected: "setup-order test passed"

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.sh test/setup-order.test.sh
git commit -m "fix(setup): define IMG_ABI before SYSTEM_IMAGE use; add python3 preflight"
```

---

### Task 2: Vendor frida-server + python venv (offline-first)

**Files:**
- Modify: `versions.env` (add pins), `scripts/setup.sh` (vendoring block + env.sh PATH), `scripts/doctor.sh` (new checks)
- Create: `.toolchain/frida/`, `.toolchain/python-venv/` are produced at runtime, not committed

**Interfaces:**
- Consumes: Task 1's arch block (`IMG_ABI`).
- Produces: `.toolchain/frida/frida-server-<ver>-android-{x86_64,arm64}.xz` decompressed (no extension); `.toolchain/python-venv/bin/{frida,frida-ps,mitmdump,mitmproxy}`; `env.sh` PATH includes the venv bin dir. `versions.env` gains `FRIDA_VERSION`, `FRIDA_TOOLS_VERSION`, `MITMPROXY_VERSION`. doctor.sh reports `frida`, `mitmdump`, `python3`, and frida-server presence.

- [ ] **Step 1: Add pins to `versions.env`**

```
FRIDA_VERSION=17.24.3
FRIDA_TOOLS_VERSION=<exact, resolve via pip index versions frida-tools>
MITMPROXY_VERSION=<exact, resolve via pip index versions mitmproxy>
```

- [ ] **Step 2: Add vendoring block to `scripts/setup.sh` after the AVD-creation section, before warm-cache**

Logic (implement as bash, same idempotent style as existing blocks): venv only if `python3` present and venv missing; frida-server download for BOTH arches (asset names `frida-server-${FRIDA_VERSION}-android-x86_64.xz` / `-android-arm64.xz` from `https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/`), `unxz`, name result without extension; each step warn-not-fatal on failure (optional-CLI pattern):

```bash
# ---- Vendored dynamic-analysis tooling (frida + mitmproxy) ----
VENV="$TOOLCHAIN/python-venv"
if command -v python3 >/dev/null 2>&1 && [ ! -x "$VENV/bin/frida" ]; then
  log "Creating python venv (frida-tools $FRIDA_TOOLS_VERSION, mitmproxy $MITMPROXY_VERSION)..."
  python3 -m venv "$VENV" && "$VENV/bin/pip" install --quiet \
    "frida-tools==${FRIDA_TOOLS_VERSION}" "mitmproxy==${MITMPROXY_VERSION}" \
    || log "WARNING: venv setup failed; frida/net_capture tools unavailable"
fi
FRIDA_DIR="$TOOLCHAIN/frida"
mkdir -p "$FRIDA_DIR"
for ASSET_ARCH in x86_64 arm64; do
  F="$FRIDA_DIR/frida-server-${FRIDA_VERSION}-android-${ASSET_ARCH}"
  if [ ! -f "$F" ]; then
    log "Downloading frida-server $FRIDA_VERSION ($ASSET_ARCH)..."
    curl -fsSL "https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/frida-server-${FRIDA_VERSION}-android-${ASSET_ARCH}.xz" -O "$F.xz" \
      && unxz -f "$F.xz" || log "WARNING: frida-server $ASSET_ARCH download failed (dynamic analysis unavailable for this ABI)"
  fi
done
```

- [ ] **Step 3: Extend `env.sh` generation with the venv bin dir**

In the heredoc that writes `.toolchain/env.sh`, PATH becomes:

```
export PATH="...\$TOOLCHAIN/python-venv/bin:\$PATH"
```

- [ ] **Step 4: Add doctor checks**

In `scripts/doctor.sh`, after the existing optional-CLI loop:

```bash
for c in frida frida-ps mitmdump python3; do
  if command -v "$c" >/dev/null 2>&1; then echo "OK   $c (dynamic)"; else warn "$c missing (run 'make setup'; dynamic analysis unavailable)"; fi
done
ls "$TOOLCHAIN"/frida/frida-server-* >/dev/null 2>&1 && echo "OK   frida-server binaries present" || warn "frida-server binaries missing (dynamic analysis unavailable)"
```

- [ ] **Step 5: Verify**

Run: `bash -n scripts/setup.sh && bash -n scripts/doctor.sh && bash test/setup-order.test.sh`
Expected: syntax OK + setup-order test passed. (Live vendoring runs on the next `make setup`; not runnable on this host — noted in report.)

- [ ] **Step 6: Commit**

```bash
git add versions.env scripts/setup.sh scripts/doctor.sh
git commit -m "feat(setup): vendor frida-server (x86_64+arm64) and python venv (frida-tools, mitmproxy)"
```

---

### Task 3: MCP tools — adb layer (adb_shell, adb_logcat, runtime_dump)

**Files:**
- Modify: `src/tools.ts` (schemas + handlers), `src/index.ts` (register 3 tools)
- Test: extend `test/smoke.test.mjs` only after Task 8; this task verifies via `npm run build` + manual tools/list smoke (existing pattern)

**Interfaces:**
- Consumes: `run()` (src/util.ts), `adbBase(deviceId?)`, `validatePackageName`.
- Produces handlers `handleAdbShell`, `handleAdbLogcat`, `handleRuntimeDump` and schemas `adbShell`, `adbLogcat`, `runtimeDump` in `ToolSchemas` — registered as `adb_shell`, `adb_logcat`, `runtime_dump`. Each returns `{ text }` via the existing response pattern.

- [ ] **Step 1: Add schemas to `ToolSchemas`**

```ts
adbShell: z.object({
  deviceId: z.string().optional(),
  command: z.string().min(1).describe("Raw shell command, e.g. dumpsys activity top"),
  timeoutSec: z.number().optional().default(60),
}),
adbLogcat: z.object({
  deviceId: z.string().optional(),
  tag: z.string().optional().describe("Filter: adb logcat tag selector, e.g. MyActivity:E or *:W"),
  pattern: z.string().optional().describe("Regex applied to captured log text"),
  durationSec: z.number().optional().default(10).describe("Seconds to wait before dumping (logcat -c then -d)"),
}),
runtimeDump: z.object({
  deviceId: z.string().optional(),
  kind: z.enum(["activity", "service", "package", "meminfo"]),
  packageName: z.string().optional(),
}),
```

- [ ] **Step 2: Implement handlers**

`handleAdbShell`: `adb shell <command>` with `timeoutSec * 1000`; reject command containing nothing (min 1 enforced by schema); raw passthrough — no blocklist (user decision).

`handleAdbLogcat`: if `clear !== false` → `adb logcat -c`; wait `durationSec` (plain `setTimeout` promise); `adb logcat -d -v time [<tag>]`; apply `pattern` with `new RegExp(pattern, "m")` filter; return joined filtered lines + total counts.

`handleRuntimeDump`: map kind → `dumpsys <kind>` (append package for `package`/`meminfo` when given, validating via `validatePackageName`).

- [ ] **Step 3: Register in `src/index.ts`** following the existing `logged(...)` pattern:

```ts
server.registerTool("adb_shell", { description: "Raw shell command passthrough to a device/emulator (high-trust; no blocklist).", inputSchema: ToolSchemas.adbShell }, logged("adb_shell", (a) => H.handleAdbShell(a)));
server.registerTool("adb_logcat", { description: "Capture filtered device logcat (clear, wait, dump, regex-filter).", inputSchema: ToolSchemas.adbLogcat }, logged("adb_logcat", (a) => H.handleAdbLogcat(a)));
server.registerTool("runtime_dump", { description: "Structured dumpsys probes: activity, service, package, meminfo.", inputSchema: ToolSchemas.runtimeDump }, logged("runtime_dump", (a) => H.handleRuntimeDump(a)));
```

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`
Expected: build OK, smoke passes (still 13 tools — count asserted exact in Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/index.ts
git commit -m "feat(mcp): adb_shell, adb_logcat, runtime_dump tools"
```

---

### Task 4: Frida script library (frida-scripts/)

**Files:**
- Create: `frida-scripts/{class-dump,crypto-trace,ssl-unpin,root-bypass,api-trace,hook-method}.js`
- Test: `test/frida-scripts.test.mjs`

**Interfaces:**
- Produces: six standalone Frida agent scripts. Contract for all: each begins with
  `var CONFIG = CONFIG || {};` then reads exactly these keys (default in parens):
  - `class-dump.js`: `regex` (`".*"`), `max` (200)
  - `crypto-trace.js`: `packages` (null = all), `maxLen` (256)
  - `ssl-unpin.js`: none
  - `root-bypass.js`: `fakePaths` (["/system/bin/su", "/system/xbin/su", "/sbin/magisk"])
  - `api-trace.js`: `hosts` (null = all)
  - `hook-method.js`: `className` (required — script no-ops with console warn if absent), `methodRegex` (`".*"`), `maxLen` (256)
  Output contract: `console.log` lines prefixed `[open-droid]`; every hook wraps in try/catch and logs failures without aborting the script.
  Task 6's `frida_trace_methods` embeds `hook-method.js` with a `CONFIG` prelude.

- [ ] **Step 1: Write the failing test**

`test/frida-scripts.test.mjs`:

```js
import { readFileSync, readdirSync } from "node:fs";
import { strict as assert } from "node:assert";
const files = readdirSync("frida-scripts").filter((f) => f.endsWith(".js"));
assert.deepEqual(files.length, 6, `expected 6 scripts, got ${files.length}`);
for (const f of files) {
  const src = readFileSync(`frida-scripts/${f}`, "utf8");
  assert.ok(src.includes("var CONFIG = CONFIG || {};"), `${f} missing CONFIG guard`);
  assert.ok(src.includes("[open-droid]"), `${f} missing [open-droid] prefix`);
  // parse check
  new (await import("node:vm")).Script(src, { filename: f });
}
console.log("frida-scripts test passed:", files.length);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/frida-scripts.test.mjs`
Expected: FAIL (directory missing)

- [ ] **Step 3: Write the six scripts**

Each single-file, dependency-free, documented contract above. `hook-method.js` core (Java layer): `Java.perform` → `Java.use(CONFIG.className)` → iterate own methods matching `methodRegex` → `overload()` variants hook entry/exit, log args (truncated `maxLen`, JSON-ish stringify) + return value. `crypto-trace.js`: hook `javax.crypto.spec.SecretKeySpec` ctor, `Cipher.getInstance/doFinal`, `MessageDigest.digest`. `ssl-unpin.js`: replace `X509TrustManager` impls + `okhttp3.CertificatePinner.check` + `javax.net.ssl.HttpsURLConnection.setSSLSocketFactory` no-op patterns. Keep each ≤120 lines; avoid obviously-failing API calls inside try/catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/frida-scripts.test.mjs`
Expected: "frida-scripts test passed: 6"

- [ ] **Step 5: Commit**

```bash
git add frida-scripts test/frida-scripts.test.mjs
git commit -m "feat(frida): curated hook-script library (class-dump, crypto-trace, ssl-unpin, root-bypass, api-trace, hook-method)"
```

---

### Task 5: src/frida.ts helper module

**Files:**
- Create: `src/frida.ts`
- Test: `test/frida.test.mjs` (imports `dist/frida.js` after build)

**Interfaces:**
- Consumes: `run`, `which`, `tmpDir` (src/util.ts); Task 2's vendored paths.
- Produces (exact signatures, used by Task 6):
  - `mapAbiToAsset(abi: string): string` — `"x86_64"→"x86_64"`, `"arm64-v8a"→"arm64"`, else throws `Error("unsupported device ABI: " + abi)`
  - `parseBuildType(prop: string): "rootable" | "nonrootable"` — `"userdebug"|"eng"→"rootable"`, anything else → `"nonrootable"`
  - `resolveFridaCli(root: string): Promise<string | null>` — `root/.toolchain/python-venv/bin/frida` if executable, else `which("frida")`
  - `ensureServer(deviceId?: string, root?: string): Promise<{ server: string; abi: string }>` — full push/start flow; throws actionable errors
  - `deviceAbi(deviceId?: string): Promise<string>` — `adb shell getprop ro.product.cpu.abi` (trim)
  - `deviceBuildType(deviceId?: string): Promise<string>` — `getprop ro.build.type`
  - `PIDFILE = <tmpdir>/android-mcp-mitm.pid` (exported; Task 7 uses it)

- [ ] **Step 1: Write the failing test**

`test/frida.test.mjs`:

```js
import { strict as assert } from "node:assert";
import { mapAbiToAsset, parseBuildType } from "./dist/frida.js";
assert.equal(mapAbiToAsset("x86_64"), "x86_64");
assert.equal(mapAbiToAsset("arm64-v8a"), "arm64");
assert.throws(() => mapAbiToAsset("mips"), /unsupported device ABI/);
assert.equal(parseBuildType("userdebug"), "rootable");
assert.equal(parseBuildType("eng"), "rootable");
assert.equal(parseBuildType("release-keys"), "nonrootable");
console.log("frida helper test passed");
```

(`resolveFridaCli` asserted separately in Step 3.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>&1 | tail -1; node test/frida.test.mjs`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `src/frida.ts`**

Signatures above. `ensureServer` flow: deviceBuildType → `nonrootable` throws `"device image 'release-keys' cannot adb root (google_apis images required; default fallback images are not rootable — re-run make setup)"` → `adb root` → sleep 2 → `adb shell getprop ro.product.cpu.abi` → `mapAbiToAsset` → server file lookup (throws with repo-relative expected path when missing) → push to `/data/local/tmp/frida-server` → `chmod 755` → kill stale (`pkill -f frida-server || true`) → `nohup ... &` via `adb shell` → verify with `frida-ps -U` returning 0. All `run()` calls use `timeout: 60_000`.

`resolveFridaCli` unit-check (append to the test):

```js
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFridaCli } from "./dist/frida.js";
const fake = mkdtempSync(join(tmpdir(), "venvtest-"));
const binDir = join(fake, ".toolchain", "python-venv", "bin");
mkdirSync(binDir, { recursive: true });
const f = join(binDir, "frida"); writeFileSync(f, "#!/bin/sh\n"); chmodSync(f, 0o755);
assert.equal(await resolveFridaCli(fake), f);
assert.notEqual(await resolveFridaCli("/nonexistent-root-xyz"), null); // falls back to PATH or null
```

(add `mkdirSync` to imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node test/frida.test.mjs`
Expected: "frida helper test passed"

- [ ] **Step 5: Commit**

```bash
git add src/frida.ts test/frida.test.mjs
git commit -m "feat(frida): helper module — ABI mapping, rootability check, CLI/server resolution"
```

---

### Task 6: frida MCP tools (frida_ps, frida_hook, frida_trace_methods)

**Files:**
- Modify: `src/tools.ts`, `src/index.ts`
- Test: `test/frida.test.mjs` (extend: schema-level validation helpers)

**Interfaces:**
- Consumes: Task 5's `ensureServer`, `resolveFridaCli`, `PIDFILE`; Task 4's `frida-scripts/hook-method.js` (embedded via fs read + `CONFIG` prelude concat).
- Produces registered tools `frida_ps`, `frida_hook`, `frida_trace_methods` (tool count 16 after this task).

- [ ] **Step 1: Add schemas**

```ts
fridaPs: z.object({ deviceId: z.string().optional() }),
fridaHook: z.object({
  packageName: z.string(),
  deviceId: z.string().optional(),
  script: z.string().optional().describe("Inline Frida JS; takes precedence over scriptPath"),
  scriptPath: z.string().optional(),
  spawn: z.boolean().optional().default(true).describe("true: spawn+resume via -f; false: attach to running process by name"),
  durationSec: z.number().optional().default(30),
}),
fridaTraceMethods: z.object({
  packageName: z.string(),
  className: z.string().describe("Exact class or regex-resolvable FQN, e.g. com.example.app.Crypto"),
  methodRegex: z.string().optional().default(".*"),
  deviceId: z.string().optional(),
  durationSec: z.number().optional().default(30),
}),
```

- [ ] **Step 2: Implement handlers**

Shared: resolve CLI (Task 5) — null → throw `"frida CLI not found — run 'make setup' (vendors python-venv)"`. `fridaPs`: `ensureServer` → `frida-ps -Uai`.

`fridaHook`: script source = inline `script` else read `scriptPath` (throw clear error if neither); write temp file; args = `-U`, spawn ? `["-f", packageName]` : `[packageName]`, `-l <tmpfile>`; run with `timeout: durationSec*1000 + 15_000`; return combined stdout/stderr.

`fridaTraceMethods`: read `frida-scripts/hook-method.js` (path resolved from repo root: `new URL("../../frida-scripts/hook-method.js", import.meta.url)`-equivalent via `__dirname` consistent with existing imports), prepend `var CONFIG = {className: "...", methodRegex: "...", maxLen: 256};`, then delegate to the same runner as `fridaHook` (spawn default true).

- [ ] **Step 3: Register in `src/index.ts`** (existing pattern; descriptions one-line each).

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`
Expected: pass (tool count still asserted loose until Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/index.ts
git commit -m "feat(mcp): frida_ps, frida_hook, frida_trace_methods tools"
```

---

### Task 7: net_capture tool (single-session mitmproxy)

**Files:**
- Modify: `src/tools.ts`, `src/index.ts`, `src/frida.ts` (export `PIDFILE` from Task 5; add `pidRunning`)
- Test: extend `test/frida.test.mjs`

**Interfaces:**
- Consumes: Task 5 `PIDFILE`, `ensureServer` (for root), `run`.
- Produces: `pidRunning(pid: number): boolean` (Task 8/10 rely on semantics), registered tool `net_capture` (tool count 17). HAR path convention: `<tmpdir>/android-mcp-mitm-<ts>.har` returned in the tool result text.

- [ ] **Step 1: Write the failing test**

Append to `test/frida.test.mjs`:

```js
import { pidRunning } from "./dist/frida.js";
assert.equal(pidRunning(-1), false);            // dead/invalid pid → false
assert.equal(pidRunning(process.pid), true);    // this test process → true
console.log("net_capture helper test passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node test/frida.test.mjs`
Expected: FAIL (`pidRunning` not exported)

- [ ] **Step 3: Implement `pidRunning` + handler + registration**

`pidRunning`: `process.kill(pid, 0)` true/false (ESRCH → false, EPERM → true).

`net_capture` schema:

```ts
netCapture: z.object({
  action: z.enum(["start", "stop"]),
  deviceId: z.string().optional(),
  port: z.number().optional().default(8080),
  durationSec: z.number().optional().default(30).describe("Seconds of traffic to collect before auto-stop (start)"),
}),
```

`start`: `pidRunning(readPIDFILE)` → throw `"net_capture busy: capture running (pidfile <PIDFILE>, port <port>)"`. Checks: mitmdump resolvable (venv first, PATH fallback, same pattern as resolveFridaCli); CA exists (`~/.mitmproxy/mitmproxy-ca-cert.pem` — run `mitmdump --version` once to generate if missing). Device profile: `ensureServer` (root) → push CA to `/system/etc/security/cacerts/` with openssl-style hash name via `adb shell` (`remount`, push, chmod 644) — warn-not-fatal if system push fails (user may trust user cert instead; message explains). Set proxy: `adb shell settings put global http_proxy 10.0.2.2:<port>` (emulator host alias; physical device → hostname resolves via same alias only on emulator — document). Launch detached `mitmdump -p <port> --set hardump=<har>` with `nohup`-style detach + write pidfile. Auto-stop: schedule SIGTERM after `durationSec` then report HAR path when written; respond immediately with "capture started (pid <pid>, har <path>)".

`stop`: read pidfile → missing/dead → `"no active capture"` → SIGTERM → wait ≤10s for HAR file → clear proxy (`settings put global http_proxy :0`) → remove pidfile → return `{ text: "capture stopped; HAR: <path> (or 'not yet written')" }`.

- [ ] **Step 4: Register in `src/index.ts`**, verify `npm run build && npm test`, commit:

```bash
git add src/tools.ts src/index.ts src/frida.ts test/frida.test.mjs
git commit -m "feat(mcp): net_capture tool — single-session mitmdump with device proxy+CA profile"
```

---

### Task 8: Smoke test — exact tool count + per-name assertions

**Files:**
- Modify: `test/smoke.test.mjs`

**Interfaces:**
- Produces: the canonical registered-tool contract: exactly 20 tools with the exact name set. README's table must match this set (Task 11 verifies).

- [ ] **Step 1: Rewrite the assertion block**

```js
const EXPECTED = new Set([
  "android_env_check", "gradle_task", "adb_devices", "adb_screenshot",
  "adb_install", "adb_launch", "emulator_list_avds", "emulator_boot",
  "maestro_run", "compose_preview_render", "android_skills_list",
  "android_skills_search", "sdkmanager_install",
  "adb_shell", "adb_logcat", "runtime_dump",
  "frida_ps", "frida_hook", "frida_trace_methods", "net_capture",
]);
assert.equal(tools.length, EXPECTED.size, "tool count drifted from 20");
const names = new Set(tools.map((t) => t.name));
for (const n of EXPECTED) assert.ok(names.has(n), `missing tool: ${n}`);
```

- [ ] **Step 2: Run to verify it passes**

Run: `npm run build && npm test`
Expected: "smoke test passed: 20 tools"

- [ ] **Step 3: Commit**

```bash
git add test/smoke.test.mjs
git commit -m "test: pin exact 20-tool contract with per-name assertions"
```

---

### Task 9: examples/vuln-app (instrumented practice target) + CI app-build job

**Files:**
- Create: `examples/vuln-app/` — full Gradle project cloned from `templates/compose-starter` structure (same AGP/Gradle/Java pins, `namespace` in build.gradle.kts, no manifest `package=`), then modified:
  - `app/src/main/java/com/example/vulnapp/CryptoBox.kt` — hardcoded `SecretKeySpec` ("vuln-demo-key-32-bytes-long!") + AES/CBC `encrypt/decrypt` via `javax.crypto`
  - `app/src/main/java/com/example/vulnapp/RootCheck.kt` — checks `File("/system/bin/su")`, `File("/sbin/magisk")`; gates navigation
  - `app/src/main/java/com/example/vulnapp/SecretActivity.kt` — reachable only after RootCheck passes; displays decrypted "flag"
  - `app/src/main/java/com/example/vulnapp/ApiService.kt` — OkHttp request to `https://httpbin.org/post` with `CertificatePinner` pin on a fixed SPKI hash (pinning exercise target; network unreachable on emulator is fine — pinning enforcement happens client-side)
  - Manifest: activities registered; label "Vuln Demo"
  - `README.md` inside the app: "TEST/DEMO TARGET ONLY — deliberately vulnerable, never publish"
- Modify: `.github/workflows/ci.yml` — add `app-build` job

**Interfaces:**
- Consumes: template structure (Task-independent; mirrors `templates/compose-starter` exactly).
- Produces: `examples/vuln-app` buildable via `gradle :app:assembleDebug`; CI job `app-build` proves it compiles (no KVM needed). Task 10 drives it dynamically.

- [ ] **Step 1: Scaffold from template, rename**

Copy `templates/compose-starter` → `examples/vuln-app`; change namespace/package to `com.example.vulnapp`; applicationId same; strip template-specific README copy.

- [ ] **Step 2: Write the four instrumentation points**

Exact contracts (Task 10 asserts against them):
- CryptoBox.encrypt(String):String — AES/CBC/PKCS5Padding, log tag `"CryptoBox"` with `Log.d("CryptoBox", "encrypting: ...")` so logcat assertions can find it
- RootCheck.isRooted():Boolean — the two File checks above
- SecretActivity shows `Toast` + `Log.d("SecretActivity", "SECRET ACCESS GRANTED")` on success
- ApiService pins `sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` (fake pin — request will fail TLS; the *pin-check invocation* is the observable, catch and log `Log.d("ApiService", "pin check failed (expected in demo)")`)

- [ ] **Step 3: CI job (build-only, no emulator)**

Append to `.github/workflows/ci.yml` `jobs:`:

```yaml
  app-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: "21" }
      - uses: android-actions/setup-android@v3
      - run: cd examples/vuln-app && gradle :app:assembleDebug --no-daemon
```

- [ ] **Step 4: Verify**

Run: `git add examples/vuln-app .github/workflows/ci.yml && git commit -m "feat(examples): vuln-app instrumented practice target + CI app-build job" && git push origin main && gh run watch --exit-status <run-id>`
Expected: `app-build` job green (this is the app's compile proof; no local toolchain needed on this host).

---

### Task 10: Integration test script (local, KVM-gated)

**Files:**
- Create: `test/integration-dynamic.sh`

**Interfaces:**
- Consumes: everything above via CLI surface (adb, frida CLI, mitmdump, `examples/vuln-app` APK), `.toolchain/env.sh`.
- Produces: the end-to-end proof for docs claims; manual/local only.

- [ ] **Step 1: Write the script**

Structure: `set -euo pipefail`; source `.toolchain/env.sh`; skip gate: no `/dev/kvm` (x86_64) or no frida CLI → `echo "SKIP: dynamic integration requires KVM + vendored toolchain"; exit 77`. Phases, each wrapped in `timeout` (Review Focus #3):
1. Boot AVD headless; wait-for-device (`timeout 180`)
2. `adb root`; build vuln-app (`gradle :app:assembleDebug` offline), `adb install`
3. `adb logcat -c` → launch app → logcat dump asserts `CryptoBox` tag present
4. `runtime_dump kind=meminfo packageName=com.example.vulnapp` asserts package appears
5. `frida-ps -U` asserts server + process list
6. `frida_hook` spawn vulnapp with `root-bypass.js` inline-wrapped → relaunch → logcat asserts `SECRET ACCESS GRANTED`
7. `crypto-trace.js` hook → trigger encrypt (Maestro tap or `am start` + monkey) → assert captured key material in hook output
8. `net_capture start` → `api-trace.js` traffic (or plain launch) → `net_capture stop` → assert HAR file exists and parses as JSON
9. Teardown: `adb emu kill`; clear proxy regardless (`finally`-style trap)

- [ ] **Step 2: Verify skip path on this host**

Run: `bash test/integration-dynamic.sh`
Expected: SKIP (exit 77 — this host has no KVM/toolchain); script must not crash.

- [ ] **Step 3: Commit**

```bash
git add test/integration-dynamic.sh
git commit -m "test: local KVM-gated dynamic-analysis integration script"
```

---

### Task 11: Skill rewrite + docs + registration refresh + final push

**Files:**
- Modify (rewrite): `skills/android-reverse-engineering/SKILL.md`
- Modify: `skills/reverse-engineer-anything/SKILL.md` (one paragraph), `skills/start-here/SKILL.md` (one paragraph in review/investigation phase), `README.md` (features + tool table 13→20 + docker quick note), `docs/troubleshooting.md` (new rows), `docs/dynamic-analysis.md` (create), `docs/quickstart.md` (one-line mention)
- Run: `scripts/register.sh` (refresh global skills)

**Interfaces:**
- Consumes: final tool set from Task 8's EXPECTED (the README table must list exactly those 20 names).
- Produces: published skill + docs; green CI on main.

- [ ] **Step 1: Rewrite `skills/android-reverse-engineering/SKILL.md`**

Keep frontmatter (name, description extended to mention dynamic/emulator: "…and dynamic analysis on a live emulator: Frida hooking, crypto/network tracing, root/SSL bypass"). Three phases + four workflows exactly as spec §4 ("analyze unknown APK", "trace API + crypto secrets", "bypass root/SSL checks", "compare two builds dynamically"), each naming exact tool calls (`frida_hook` with inline script embedding the shared `CONFIG` prelude shown literally once).

- [ ] **Step 2: Write `docs/dynamic-analysis.md`**

Setup → tool reference (all 7 new tools with arg tables) → the four workflows → troubleshooting cross-ref. One page, command-first.

- [ ] **Step 3: README + troubleshooting rows**

README: tool table gains the 7 rows; features list gains one bullet ("Dynamic analysis: Frida hooks, mitmproxy capture, runtime observation"); quick start note that `make setup` now vendors dynamic tooling. Troubleshooting rows: frida-server arch mismatch, `adb root` on default images, CA-cert install failure, proxy stuck after capture stop, python3 missing.

- [ ] **Step 4: Refresh registration + full verify**

Run: `bash scripts/register.sh && npm run build && npm test && bash -n scripts/*.sh && python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/release.yml']]"`
Expected: skills refreshed (35), smoke passes (20 tools), YAML valid.

- [ ] **Step 5: Commit, push, watch CI**

```bash
git add -A
git commit -m "feat(skill): android-reverse-engineering static->dynamic loop; docs for dynamic analysis"
git push origin main
gh run watch --exit-status <run-id>
```

Expected: CI green (`mcp`, `docker`, `app-build` jobs).
