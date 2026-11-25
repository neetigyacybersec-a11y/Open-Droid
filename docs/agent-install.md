# Installing / Updating the android-mcp server for coding agents & harnesses

This document is written for **coding agents and harnesses** (OpenCode, Claude Code,
Cursor, Codex, and any MCP-capable client) that need exact, reproducible steps to
install, register, verify, and update the `android-mcp` MCP server and its skills.
It is intentionally literal: every command is copy-pasteable, and every state check
has an expected output.

- Repository: `https://github.com/<owner>/android-mcp.git` (local path assumed below: `$REPO`)
- MCP server name (registered): `android-mcp`
- Transport: stdio from a host process. Docker is an optional **toolchain
  backend**, never the MCP transport (ISSUE-168).
- Tool count contract: exactly **79 tools** (source of truth: `src/registry.ts`; checked by `test/smoke.test.mjs`)

---

## 0. Prerequisites (host)

| Requirement | Check | Install (Debian/Ubuntu) |
|---|---|---|
| Git | `git --version` | `sudo apt install -y git` |
| Node ≥ 22 | `node --version` | via nvm or `make setup` |
| Java 21 (JDK) | `java -version` | Auto-downloaded by `make setup` (Temurin, via Adoptium) if absent; or `sudo apt install -y temurin-21-jdk` |
| Python 3 + venv | `python3 --version` | `sudo apt install -y python3 python3-venv` (on Windows, install real Python from python.org — the Microsoft Store `python3` alias stub exists on PATH but runs nothing and is rejected) |
| KVM (x86_64 only) | `ls -l /dev/kvm` | `sudo apt install -y qemu-kvm && sudo gpasswd -a $USER kvm` (then re-login) |
| Docker (optional) | `docker --version` | `sudo apt install -y docker.io` |
| OpenCode CLI (for registration) | `opencode --version` | https://opencode.ai |

Agent/harness-specific MCP clients (Claude Desktop, Cursor, Codex) do not need the
OpenCode CLI; they consume the stdio server directly via their own config.

Docker toolchain mode (§2.3) replaces the host Java/Android SDK/Gradle/Python
requirements with a local Docker engine; Node and `adb` still run on the host.

---

## 0.5 Root / sudo requirements (important)

**No root is required for the core install.** `make setup` writes everything into
`./.toolchain/` (user-owned) and registers MCP/skills in `~/.config/opencode/`
(user-owned). You only need elevated privileges for two optional things:

| Item | Needs root? | If you lack root |
|---|---|---|
| JDK (Temurin 21) | No — auto-downloaded by `make setup` into `.toolchain/jdk` | Nothing; works automatically |
| Android SDK, Gradle, Maestro, frida, mitmproxy | No — all vendored into `.toolchain/` | Nothing |
| MCP registration / skills | No — written to `~/.config/opencode/` | Nothing |
| `python3` / `python3-venv` | Only if not already installed (apt) | Dynamic analysis is skipped; core build/test still work. Install via your distro's package manager or a user-level Python (pyenv). |
| KVM group membership (`/dev/kvm` writable) | Yes (for x86_64 emulator) | Use an ARM64 host with arm64 images, a physical Android device via `adb`, or ask your admin: `sudo gpasswd -a $USER kvm` + re-login. |

If `make doctor` reports a missing optional item, the rest of the toolkit still
works — only the related feature (dynamic analysis / emulator) is unavailable.

## 1. Fresh install (clone + one-time setup)

### 1.1 Clone

```bash
git clone https://github.com/neetigyacybersec-a11y/Open-Droid.git
cd Open-Droid
export REPO="$(pwd)"
```

> **SSH vs HTTPS:** The clone above uses HTTPS, which works for everyone without
> any key setup. If you prefer SSH (`git@github.com:...`), you must have a
> configured GitHub SSH key, otherwise you get `Permission denied (publickey)`.
> See `docs/troubleshooting.md` (Git clone row).

### 1.2 One-time setup (downloads ~3 GB into `./.toolchain/`)

```bash
make setup
```

What `make setup` does (idempotent; safe to re-run):

1. Downloads Temurin JDK, Android SDK command-line tools, platform, build-tools, emulator, system image (ABI from `uname -m`), Gradle, Maestro.
2. Vendors dynamic-analysis tooling: frida-server (x86_64 + arm64, 17.24.3) into `.toolchain/frida/`, and a Python venv (`frida-tools` 14.11.0 + `mitmproxy` 12.3.1) into `.toolchain/python-venv/`.
3. Exports env via `.toolchain/env.sh`.
4. Warms the Gradle dependency cache (one online build).
5. Runs `scripts/register.sh`:
   - registers the MCP server **globally** (`opencode mcp add android-mcp --global`) if not already present;
   - copies every skill directory from `skills/` into `~/.config/opencode/skills/`, including `references/**`, `templates/**`, examples and scripts (refreshed every run);
   - fails with a non-zero exit and leaves the manifest unchanged if any skill copy fails;
   - prunes only skills previously installed by this repo (tracked in `~/.config/opencode/skills/.android-mcp-manifest`), plus the eight names dropped by the 2026-10 consolidation. Unrelated user skills are never deleted.
6. Builds the MCP server (`npm run build`).

### 1.3 Source the toolchain (current shell)

```bash
source .toolchain/env.sh
```

### 1.4 Verify

```bash
make doctor
```

Expected (abridged):
```
[doctor] OK   java ...
[doctor] OK   gradle ...
[doctor] OK   adb ...
[doctor] OK   emulator ...
[doctor] OK   sdkmanager ...
[doctor] OK   maestro ...
[doctor] OK   frida (dynamic)
[doctor] OK   frida-ps (dynamic)
[doctor] OK   mitmdump (dynamic)
[doctor] OK   python3 (dynamic)
[doctor] OK   frida-server binaries present
[doctor] OK    android-mcp present in global opencode config
```

Agents should read the machine-readable report before proposing a repair:

```bash
node scripts/doctor-json.mjs            # JSON, schema install/doctor.schema.json
node scripts/repair.mjs --component gradle --dry-run
node scripts/repair.mjs --component gradle --yes    # explicit confirmation
```

The JSON report separates registered tools from runnable capabilities, finds
managed executables even when they are not on `PATH`, and reports device or
emulator absence separately from core installation health. `repair` is dry-run
by default, accepts named components only, and never edits user projects or Git
state.
```

### 1.5 Build the MCP server (if not already built)

```bash
npm run build
npm test            # smoke test (79 tools) + tools + frida-scripts + frida helper
```

Expected: `smoke test passed: 79 tools` and `frida helper test passed`.

### 1.6 Configure the execution policy

The server defaults to `balanced`: inspection tools run, while destructive,
device-state and other gated operations need a short-lived, single-use approval
token. Before using gated tools, set a shared secret in the environment that
launches the MCP server:

```bash
export ANDROID_MCP_APPROVAL_SECRET="$(openssl rand -hex 32)"
```

Keep the same secret for the host or human who signs requests with
`npm run approve -- '<approval-request>'`. Use `ANDROID_MCP_POLICY=restricted`
with `ANDROID_MCP_ALLOW` for a tighter allowlist, or
`ANDROID_MCP_POLICY=permissive` only for a deliberately trusted session. The
server prints its mode and approval status at startup. Full configuration,
impact classes and limitations:
[docs/execution-policy.md](execution-policy.md).

---

## 2. Registering with a coding agent / harness

### 2.1 OpenCode (global, recommended)

`make setup` already did this. To re-run or repair:

```bash
make register        # == bash scripts/register.sh
opencode mcp list    # should show android-mcp
```

Manual equivalent:
```bash
opencode mcp add android-mcp --global -- bash "$REPO/scripts/run-mcp.sh"
```

Skills are discovered from `~/.config/opencode/skills/` (copied by `make register`).
Refresh after any skill edit:
```bash
make register
```

### 2.2 Claude Code / Cursor / Codex (stdio, per-project or user-wide)

Add to the client's MCP config (e.g. `~/.claude/mcp.json`, `.cursor/mcp.json`, or the
project's `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "android-mcp": {
      "type": "stdio",
      "command": "bash",
      "args": ["$REPO/scripts/run-mcp.sh"]
    }
  }
}
```

Replace `$REPO` with the absolute path. Ensure `npm run build` has produced `dist/index.js`
and `scripts/run-mcp.sh` is executable (`chmod +x scripts/run-mcp.sh`).

For skills, copy manually:
```bash
cp -r "$REPO/skills/"* ~/.claude/skills/   # or ~/.cursor/skills/, etc.
```

### 2.2.1 Client registration scopes

`scripts/clients.mjs` registers the MCP server explicitly per client and scope.
Only adapters with fixture tests are advertised: **OpenCode** (global and
project-local), **Claude Code** (user) and **Cursor** (user). `inspectClient`,
`registerClient` and `unregisterClient` are idempotent, preserve unrelated
configuration and JSONC comments, back up before writing, track copied skills
and detect stale paths. Doctor reports registration drift and whether an MCP
client restart is required. No other client is claimed as supported.

### 2.3 Docker toolchain (no host Android toolchain)

The MCP server stays on the host. The image is toolchain-only: it carries no
`src/`, `dist/`, `node_modules/` or MCP entrypoint. Build and verify it locally:

```bash
docker build -t open-droid-toolchain:0.1.0 .
docker run --rm --entrypoint bash open-droid-toolchain:0.1.0 scripts/docker-smoke.sh
```

The image carries every non-device dependency used by registered handlers:
Gradle, the Android SDK (including `aapt2` in build-tools), JADX, apktool,
Compose Preview CLI, the Android CLI, Maestro, and a pinned Python venv with
`frida`, `frida-ps`, `mitmdump` and both ABI-specific `frida-server` assets.
Versions and upstream SHA-256 digests live in `versions.env`, which is sourced
by both `scripts/setup.sh` and the Dockerfile. The build runs the same smoke
script; CI repeats it against the built image.

Host MCP config (OpenCode):
```jsonc
{
  "mcp": {
    "servers": {
      "android-mcp": {
        "type": "local",
        "command": ["node", "/absolute/path/to/Open-Droid/dist/index.js"],
        "environment": { "ANDROID_MCP_TOOLCHAIN_IMAGE": "open-droid-toolchain:0.1.0" }
      }
    }
  }
}
```

With that variable set, toolchain commands execute through `docker run`; the
server reports the image separately from host MCP health in `android_env_check`.
A missing Docker daemon or image is an error, never a host-tool fallback. The
Docker endpoint must be local (or see the same paths as the MCP host); a remote
context such as `ssh://...` is rejected because its bind mounts point at another
machine. Windows path translation is not implemented yet and fails closed.

> The container route cannot run the Android emulator (Docker Desktop does not
> expose `/dev/kvm`). The host owns USB devices, the ADB server and emulators;
> use a physical device (`adb_wifi { action: "connect", host: "<phone-ip>" }`)
> or a host/WSL2 emulator bridged with
> `-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037`.

### 2.4 Appllama MCP (optional, separate)

The Appllama design MCP is a paid, network-only service and is **not** integrated
into this repo. If you want it, add it separately:
```jsonc
{ "mcpServers": { "Appllama": { "type": "http", "url": "https://mcp.appllama.io/mcp" } } }
```
See `docs/appllama-integration-analysis.md` for why it was not bundled.

### 2.5 REA provider (optional, external)

The reverse-engineering skills use a separate `rea` MCP for native `.so`,
Ghidra and packed-asset analysis. Open-Droid does **not** install or start it;
JADX/apktool static analysis works without it. Install the pinned provider and
restart the client, otherwise its tools will not appear:

```bash
npx -y rea-agents@6.3.0 setup --client opencode --yes
export REA_JADX_MCP_JAR=/absolute/path/to/jadx-headless-mcp.jar  # bring-your-own JAR
```

`android_env_check` prints `rea provider: unavailable (optional external MCP;
tools: inspect_android_package, search_android_classes; setup: ...)` when it is
not configured, including the ids the skills expect. That is a capability
report, not a broken Open-Droid install. Docker images do not bundle REA or
Ghidra; run the provider on the host when you need it. The pinned provider is
`rea-agents@6.3.0` (MIT licence); it requires Java 21+ and an analysis engine
(Ghidra or a bring-your-own JADX MCP JAR — upstream publishes no fixed JAR URL
or checksum). Changing provider configuration always requires an MCP client
restart/reconnect before the new tools appear in `tools/list`.

---

## 3. Updating the MCP (existing install)

### 3.1 Guarded update (recommended)

```bash
cd "$REPO"
npm run update              # or `make update`
```

`npm run update` refuses a dirty tree (staged, unstaged or untracked files),
detached HEAD, a missing upstream and diverged or ahead branches. It fetches,
requires a fast-forward, then runs `npm ci`, `npm run build`, `npm run verify`
and registration in order. The first failing stage stops the command and is
named in the output. It never runs `git reset --hard`, force-push or rebase.
Pass `--no-register` to skip the registration refresh.

### 3.2 Manual equivalent

```bash
cd "$REPO"
git fetch origin
git status --short          # must be empty
git merge --ff-only origin/main
npm ci
npm run build
npm run verify
make register
```

Restart the MCP client after rebuilding. Clients cache `tools/list` for the
lifetime of the session; the running server keeps the code it loaded at startup.
`android_env_check` prints `server:`, `server build:`, `on-disk build:` and
`restart required: YES|no`, so an agent can detect a stale process without
guessing. `scripts/run-mcp.sh` and `npm start` also refuse to launch when
`dist/` predates the current `src/` tree.

### 3.3 Refresh toolchain (only if `versions.env` or `scripts/setup.sh` changed)

```bash
make setup                  # idempotent; re-vendors only missing/outdated pieces
make doctor
```

### 3.4 Refresh registration (skills + MCP)

```bash
make register               # copies latest skills, prunes removed ones, verifies MCP
```

### 3.5 Verify the update

```bash
opencode mcp list           # android-mcp present
make doctor                 # all OK
npm test                    # 79 tools
```

### 3.6 If you are on a feature branch / worktree

```bash
git checkout main
git pull --ff-only origin main
# merge your feature branch
git merge <feature-branch>
npm ci && npm run build && npm test
make register
```

### 3.7 Updating a Docker toolchain install

The host MCP server and the toolchain image update independently:

```bash
cd "$REPO"
git pull --ff-only origin main
npm ci && npm run build
# rebuild only when versions.env or the toolchain changed:
docker build -t open-droid-toolchain:<new-tag> .
# point ANDROID_MCP_TOOLCHAIN_IMAGE at the new tag and restart the MCP process
```

Restart the client only for MCP code/config changes; a cached image keeps
working offline. Remote Docker contexts are rejected (their mounts point at
another machine).

---

## 4. Agent/harness self-check (run before claiming "installed")

A coding agent should run these and only report success if all pass:

```bash
cd "$REPO"
# 1. Build
npm run build && echo "BUILD OK" || echo "BUILD FAIL"

# 2. Tests
npm test && echo "TESTS OK" || echo "TESTS FAIL"

# 3. Tool count contract
node test/smoke.test.mjs && echo "SMOKE OK" || echo "SMOKE FAIL"

# 4. Toolchain
make doctor

# 5. MCP registration (OpenCode)
opencode mcp list | grep -q android-mcp && echo "MCP OK" || echo "MCP MISSING"

# 6. Skills count
ls ~/.config/opencode/skills | wc -l   # expect 31

# 7. Dynamic tools present
node -e "const {spawn}=require('child_process');const p=spawn('node',['dist/index.js'],{stdio:['pipe','pipe','pipe']});let o='';p.stdout.on('data',d=>o+=d);const i=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'t',version:'1'}}});const l=JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});p.stdin.write(i+'\n');p.stdin.write(l+'\n');setTimeout(()=>{p.kill();const t=JSON.parse(o.trim().split('\\n').find(x=>JSON.parse(x).id===2)).result.tools.map(x=>x.name);console.log('tools:',t.length);console.log('has net_capture:',t.includes('net_capture'));},2000);"
```

Expected final lines: `BUILD OK`, `TESTS OK`, `SMOKE OK`, all doctor checks `OK`,
`MCP OK`, skills count `31`, tools `79`, `has net_capture: true`.

---

## 5. Troubleshooting (agent-facing)

| Symptom | Cause | Fix |
|---|---|---|
| `npm test` fails at smoke (tool count ≠ 79) | Tool registration drift | Check `src/registry.ts` includes all 79 and matches `test/smoke.test.mjs`; rebuild |
| A new/renamed tool is missing after pulling or rebuilding | MCP clients cache `tools/list`; the running server still has the old build | Call `android_env_check`: `restart required: YES` means the on-disk build changed after startup — restart the MCP client/server. If it says `no` but the client still shows old tools, restart the client anyway |
| `make doctor` reports `frida` missing | Venv not created | `sudo apt install -y python3 python3-venv && make setup` |
| `make doctor` reports frida-server missing | Download failed | Check network; re-run `make setup` |
| `opencode mcp list` lacks android-mcp | Not registered globally | `make register` or `opencode mcp add android-mcp --global -- bash $REPO/scripts/run-mcp.sh` |
| Skills stale after pull | Global copies not refreshed | `make register` |
| `Cannot find module dist/index.js` | Not built | `npm run build` |
| `frida CLI not found` at runtime | Venv absent | `make setup` |
| `device image 'release-keys' cannot adb root` | Non-rootable image | Re-run setup on a KVM host; ensure `google_apis` image |
| `net_capture busy` | Capture already running | `net_capture stop`, then retry |
| Proxy stuck after capture | `stop` not called / MCP exited | `net_capture stop` restores the persisted original value; follow any `recovery-required` command it prints |
| Global skills deleted unexpectedly | Old register.sh (pre-manifest) | Update to latest; manifest now protects user skills |

See `docs/troubleshooting.md` for the full host-install checklist.

---

## 6. File layout reference (for agents locating things)

```
$REPO/
├── src/                    # MCP server (TypeScript, stdio) — tools.ts, index.ts, frida.ts, util.ts
├── dist/                   # Compiled server (npm run build) — gitignored
├── skills/                 # 29 OpenCode skills (source of truth)
├── frida-scripts/          # 6 curated Frida agent scripts
├── examples/vuln-app/      # Deliberately-vulnerable practice app
├── scripts/                # setup.sh, register.sh, doctor.sh, run-mcp.sh, warm-cache.sh
├── docs/                   # quickstart, dynamic-analysis, troubleshooting, ...
├── test/                   # smoke, tools, frida-scripts, frida, setup-order, integration-dynamic
├── .toolchain/             # Vendored toolchain (gitignored) — created by make setup
├── versions.env            # Pinned versions (FRIDA_VERSION, etc.)
└── .opencode/opencode.jsonc # Project-level MCP registration
```

Global (outside repo, created by `make register`):
- `~/.config/opencode/opencode.jsonc` — global MCP entry for `android-mcp`
- `~/.config/opencode/skills/` — copies of all 29 skills + `.android-mcp-manifest`
- `~/.config/opencode/skills/<name>/SKILL.md`

---

## 6.5 Release channels and package managers

Tagged releases produce versioned host-install artifacts for Windows, macOS and
Linux (x64 and arm64). Each tarball is listed with its SHA-256 in `SHA256SUMS`
and is associated with the exact source commit in `release-manifest.json`.
Stable tags look like `v0.1.0`; Preview tags look like `v0.2.0-preview.3` and
are opt-in — never install a Preview artifact unless you deliberately select
that channel.

- **Windows:** `winget install Neetigyacybersec.OpenDroid --version <version>`
  (the generated WinGet manifest pins the immutable release asset and digest).
  `winget upgrade` moves between pinned versions.
- **macOS:** the generated Homebrew formula pins the version, URL and SHA-256;
  `brew install <tap>/open-droid` and `brew upgrade <tap>/open-droid` use only
  published release assets.
- **Linux:** use the generated pinned-version installer from the release
  (`linux/install.sh`); it verifies `sha256sum` before extraction.

To roll back a package-manager install, install the previous pinned version
explicitly (`winget install --version` / `brew install` of the older formula) and
restart the MCP client. `npm run rollback list` shows managed runtime
generations. Uninstall with the package manager (`winget uninstall`,
`brew uninstall`) or `npm run uninstall:local -- --dry-run` for a source checkout;
see [section 7](#7-uninstall).

## 7. Uninstall

```bash
# Remove global registration
opencode mcp remove android-mcp --global   # if supported, else edit ~/.config/opencode/opencode.jsonc

# Remove skills (only those this repo installed)
rm -rf ~/.config/opencode/skills/.android-mcp-manifest
# (leave user skills; remove android-* and the 29 names manually if desired)

# Remove repo
rm -rf "$REPO"
```

---

*This document is the contract between the repository and any coding agent/harness
that installs or updates it. If a step here disagrees with the code, the code wins
and this document must be updated in the same PR.*
