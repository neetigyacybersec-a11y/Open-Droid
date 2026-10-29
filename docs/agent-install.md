# Installing / Updating the android-mcp server for coding agents & harnesses

This document is written for **coding agents and harnesses** (OpenCode, Claude Code,
Cursor, Codex, and any MCP-capable client) that need exact, reproducible steps to
install, register, verify, and update the `android-mcp` MCP server and its skills.
It is intentionally literal: every command is copy-pasteable, and every state check
has an expected output.

- Repository: `https://github.com/<owner>/android-mcp.git` (local path assumed below: `$REPO`)
- MCP server name (registered): `android-mcp`
- Transport: stdio (local) or Docker (`ghcr.io/.../open-droid`)
- Tool count contract: exactly **20 tools** (see `test/smoke.test.mjs`)

---

## 0. Prerequisites (host)

| Requirement | Check | Install (Debian/Ubuntu) |
|---|---|---|
| Git | `git --version` | `sudo apt install -y git` |
| Node ≥ 22 | `node --version` | via nvm or `make setup` |
| Java 21 (JDK) | `java -version` | Auto-downloaded by `make setup` (Temurin, via Adoptium) if absent; or `sudo apt install -y temurin-21-jdk` |
| Python 3 + venv | `python3 --version` | `sudo apt install -y python3 python3-venv` |
| KVM (x86_64 only) | `ls -l /dev/kvm` | `sudo apt install -y qemu-kvm && sudo gpasswd -a $USER kvm` (then re-login) |
| Docker (optional) | `docker --version` | `sudo apt install -y docker.io` |
| OpenCode CLI (for registration) | `opencode --version` | https://opencode.ai |

Agent/harness-specific MCP clients (Claude Desktop, Cursor, Codex) do not need the
OpenCode CLI; they consume the stdio server directly via their own config.

---

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
   - copies all skills from `skills/` into `~/.config/opencode/skills/` (refreshed every run);
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

### 1.5 Build the MCP server (if not already built)

```bash
npm run build
npm test            # smoke test (20 tools) + tools + frida-scripts + frida helper
```

Expected: `smoke test passed: 20 tools` and `frida helper test passed`.

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

### 2.3 Docker (zero host toolchain)

```bash
docker pull ghcr.io/neetigyacybersec-a11y/open-droid:latest
```

MCP config:
```jsonc
{
  "mcpServers": {
    "android-mcp": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "--device", "/dev/kvm",
               "ghcr.io/neetigyacybersec-a11y/open-droid:latest"]
    }
  }
}
```

Note: dynamic analysis (Frida/mitmproxy) is available in the image only if the
image was built with `make setup` baked in; check `make doctor` inside the container.

### 2.4 Appllama MCP (optional, separate)

The Appllama design MCP is a paid, network-only service and is **not** integrated
into this repo. If you want it, add it separately:
```jsonc
{ "mcpServers": { "Appllama": { "type": "http", "url": "https://mcp.appllama.io/mcp" } } }
```
See `docs/appllama-integration-analysis.md` for why it was not bundled.

---

## 3. Updating the MCP (existing install)

### 3.1 Pull latest

```bash
cd "$REPO"
git fetch origin
git status --short          # ensure clean working tree (stash if needed)
git pull --ff-only origin main
```

### 3.2 Rebuild

```bash
npm ci                      # or `npm install` if lockfile changed
npm run build
npm test                    # must pass: smoke 20 tools + ...
```

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
npm test                    # 20 tools
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

### 3.7 Updating a Docker install

```bash
docker pull ghcr.io/neetigyacybersec-a11y/open-droid:latest
# restart your client; no further steps
```

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
`MCP OK`, skills count `29`, tools `20`, `has net_capture: true`.

---

## 5. Troubleshooting (agent-facing)

| Symptom | Cause | Fix |
|---|---|---|
| `npm test` fails at smoke (tool count ≠ 20) | Tool registration drift | Check `src/index.ts` registers all 20; rebuild |
| `make doctor` reports `frida` missing | Venv not created | `sudo apt install -y python3 python3-venv && make setup` |
| `make doctor` reports frida-server missing | Download failed | Check network; re-run `make setup` |
| `opencode mcp list` lacks android-mcp | Not registered globally | `make register` or `opencode mcp add android-mcp --global -- bash $REPO/scripts/run-mcp.sh` |
| Skills stale after pull | Global copies not refreshed | `make register` |
| `Cannot find module dist/index.js` | Not built | `npm run build` |
| `frida CLI not found` at runtime | Venv absent | `make setup` |
| `device image 'release-keys' cannot adb root` | Non-rootable image | Re-run setup on a KVM host; ensure `google_apis` image |
| `net_capture busy` | Capture already running | `net_capture stop`, then retry |
| Proxy stuck after capture | `stop` not called | `adb shell settings put global http_proxy :0` |
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
- `~/.config/opencode/skills/` — copies of all 31 skills + `.android-mcp-manifest`
- `~/.config/opencode/skills/<name>/SKILL.md`

---

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
