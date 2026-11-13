# Open-Droid

[![CI](https://github.com/neetigyacybersec-a11y/Open-Droid/actions/workflows/ci.yml/badge.svg)](https://github.com/neetigyacybersec-a11y/Open-Droid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-MCP-blue)](https://opencode.ai)

> **Clone. Setup once. Build Android apps offline — with a senior-level AI engineering team.**

Open-Droid is a self-contained toolkit that turns [OpenCode](https://opencode.ai) into a
full Android product studio: a single combined **MCP server** wrapping the entire
Android toolchain, a **vendored toolchain bootstrap** (fully offline after the first run),
**30 curated skills** (Android/UI, senior UI/UX design, Superpowers SDE, reverse
engineering, and an end-to-end `start-here` orchestrator), a **Material 3 Compose
starter template**, and a **self-contained Docker image**.

No scattered MCP servers. No repeated downloads. No "works on my machine."

---

## Table of contents

- [Features](#features)
- [Quick start — Docker (zero downloads)](#quick-start--docker-zero-downloads)
- [Quick start — Clone + setup (automatic registration)](#quick-start--clone--setup-automatic-registration)
- [What's included](#whats-included)
- [Skills (30)](#skills-30)
- [MCP tools (66)](#mcp-tools-66)
- [Create your first app](#create-your-first-app)
- [Live visual output](#live-visual-output)
- [Architecture](#architecture)
- [Development](#development)
- [Docker](#docker)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Features

- **One MCP server** instead of 8–10 — lower context cost, simpler config.
- **Automatic registration** — `make setup` registers the MCP server (global) and installs
  all skills into OpenCode's global skills directory. No manual config editing.
- **Offline-first** — the toolchain is downloaded once into `.toolchain/`; everything
  afterwards is local, including Gradle dependency resolution.
- **Senior UI/UX baked in** — Material 3, adaptive layouts, WCAG accessibility, design
  tokens, motion, research methods, usability testing.
- **Professional dev flow** — `start-here` orchestrates idea → discovery → design →
  spec → TDD implementation → review → ship, pulling in the right skills at each phase.
- **Visual verification** — emulator + ADB screenshots + Maestro E2E + Compose previews
  + screenshot regression.
- **Dynamic analysis** — static→dynamic reverse-engineering loop: Frida hooks,
  mitmproxy capture, runtime observation, root/SSL bypass (7 new MCP tools).
- **Self-contained Docker image** — `docker build` and run; no host toolchain needed.
- **CI/CD** — GitHub Actions build/test on PR; on tag, publish Docker image to GHCR.

---

## Quick start — Docker (zero downloads)

No pre-built image is published yet, so build it locally first (one-time; the
multi-stage build downloads several GB — start **Docker Desktop first**, the
first build takes a while):

```bash
docker build -t open-droid:latest .
```

Wire into OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "servers": {
    "android-mcp": {
      "type": "local",
      "command": ["docker", "run", "-i", "--rm", "open-droid:latest"]
    }
  }
}
```

> Shape verified against what `opencode mcp add --global` itself writes.

> The container route cannot run the Android emulator (Docker Desktop does not
> expose `/dev/kvm`). See [Docker](#docker) for the supported alternatives
> (physical device or a host/WSL2 emulator bridged via `ADB_SERVER_SOCKET`).

---

## Quick start — Clone + setup (automatic registration)

> **Prerequisites** (what the README assumes on the host): `git`, `node >= 22`
> (system node or setup auto-installs), and for dynamic analysis a **runnable**
> `python3` — the Windows Store "python3" alias stub exists on PATH but runs
> nothing, and installs/scripts correctly reject it. `make` itself is not
> available on Windows: run the underlying scripts directly, e.g.
> `bash scripts/setup.sh`, `bash scripts/doctor.sh` (Git Bash / MSYS).
>
> `scripts/setup.sh` supports Linux, macOS, and Windows (Git Bash/MSYS) hosts;
> platform gaps (e.g. optional Android CLI binaries) degrade to warnings, and
> the core JDK/SDK/npm bootstrap completes on all three.

```bash
git clone https://github.com/neetigyacybersec-a11y/Open-Droid.git
cd Open-Droid

make setup          # one-time ~3 GB download + auto-registers with OpenCode
source .toolchain/env.sh
make doctor         # toolchain + OpenCode registration + KVM checks
```

What `make setup` does automatically:
1. Installs the full Android toolchain into `.toolchain/` (arch-aware: x86_64 ↔ arm64).
2. Warms the Gradle cache once so later builds work with `--offline`.
3. **Registers the MCP server globally** (`opencode mcp add android-mcp --global`), so it
   works from any working directory.
4. **Installs all 30 skills globally** into `~/.config/opencode/skills/`, so they are
   discovered everywhere.
5. Creates the project-level `.opencode/` config + skills symlink for repo-local use.

Refresh registration any time with `make register`.

---

## What's included

| Path | Purpose |
|---|---|
| `src/` | TypeScript MCP server (stdio) |
| `dist/` | Compiled server (generated) |
| `scripts/` | `setup.sh`, `register.sh`, `doctor.sh`, `new-app.sh`, `run-mcp.sh`, `warm-cache.sh`, `repo-hygiene.sh` |
| `templates/compose-starter/` | Material 3 Compose starter app (AGP 8.7.2, Java 17, launcher icons) |
| `examples/hello-compose/` | Finished example app |
| `skills/` | 30 OpenCode skills |
| `docker/` | Dockerfile + entrypoint |
| `docs/` | Quickstart, architecture, offline contract, publishing, lifecycle coverage, troubleshooting |
| `manifest/` | Lifecycle stages, capability status, and CI gate allowlist (FR-R22) |
| `.github/workflows/` | CI + release pipelines |
| `Makefile` | Common tasks |

---

## Skills (30)

**Orchestrator (1):** `start-here` — idea → discovery → design → spec → TDD → review → ship

**Android / UI (9):** `android-compose-ui-ux`, `design-tokens`, `figma-to-compose`,
`android-accessibility`, `android-screenshot-diff`, `android-emulator-smoke`,
`android-gradle-troubleshoot`, `android-performance`, `privacy-compliance`

**Senior UI/UX design (5):** `wcag-audit`, `ux-research-planning`,
`usability-testing`, `design-critique`, `content-design-microcopy`


**Superpowers SDE (13):** `brainstorming`, `dispatching-parallel-agents`,
`executing-plans`, `finishing-a-development-branch`, `receiving-code-review`,
`requesting-code-review`, `subagent-driven-development`, `systematic-debugging`,
`test-driven-development`, `using-git-worktrees`, `verification-before-completion`,
`writing-plans`, `writing-skills`

**Reverse engineering (2):** `reverse-engineer-anything`, `android-reverse-engineering`

See `THIRD-PARTY.md` for attribution.

---

## MCP tools (66)

The server exposes 66 tools grouped by category. The full list with schemas is
returned by `tools/list` (MCP); `docs/agent-install.md` covers installation,
registration, and verification.

| Category | Count | Examples |
|---|---|---|
| Environment / build | 6 | `android_env_check`, `gradle_task`, `gradle_test`, `gradle_lint`, `build_variant`, `baseline_profile_generate` |
| ADB core | 6 | `adb_devices`, `adb_screenshot`, `adb_install`, `adb_launch`, `adb_push`, `adb_pull` |
| ADB device interaction | 10 | `adb_shell`, `adb_input`, `adb_deep_link`, `adb_broadcast`, `adb_wifi`, `adb_battery`, `adb_reboot`, ... |
| ADB logs & diagnostics | 4 | `adb_logcat`, `logcat_filtered`, `anr_check`, `crash_summary` |
| Emulator / AVD | 7 | `emulator_list_avds`, `emulator_boot`, `avd_create`, `avd_delete`, `avd_wipe`, `emulator_snapshot`, ... |
| Frida (dynamic) | 4 | `frida_ps`, `frida_hook`, `frida_trace_methods`, (+ ensureServer) |
| Network capture | 1 | `net_capture` (single-session mitmproxy) |
| UI inspection | 3 | `ui_dump`, `compose_recomposition`, `layout_bounds` |
| Static analysis | 5 | `apk_info`, `apk_decompile`, `manifest_inspect`, `native_libs`, `dex_strings` |
| Testing | 3 | `instrumented_test`, `test_coverage`, `macrobenchmark` |
| Profiling | 3 | `perfetto_trace`, `memory_profile`, `startup_time` |
| Multi-device | 1 | `adb_parallel` |
| APK serving (localhost) | 1 | `apk_serve` (python http.server in the APK output dir; binds 127.0.0.1, `expose:true` opts into 0.0.0.0) |
| Skills / SDK | 4 | `android_skills_list`, `android_skills_search`, `sdkmanager_install`, `compose_preview_render` |
| Privacy / compliance | 1 | `privacy_scan` (permissions, SDKs, endpoints, storage, account flows, PII logs, declaration diff) |
| Security audit | 3 | `secret_scan` (redacted credentials), `security_audit` (manifest/components), `policy_preflight` (sourced Play policy checks) |
| Maestro | 1 | `maestro_run` |

Run `tools/list` for the exact schema of every tool.


---

## Create your first app

```bash
source .toolchain/env.sh
make new-app my-app
make build-app APP_DIR=my-app
```

---

## Live visual output

```bash
make emulator          # boot AVD (requires KVM)
make screenshot        # -> screenshots/screen.png
```

---

## Architecture

```
Open-Droid/
├── src/            # MCP server (TypeScript, stdio)
├── skills/         # 30 OpenCode skills
├── templates/      # Compose starter
├── examples/       # Finished sample app
├── manifest/       # Lifecycle stages, capabilities and gates
├── scripts/        # setup, register, doctor, new-app, run-mcp, warm-cache, repo-hygiene
├── docker/         # Dockerfile + entrypoint
├── docs/           # Guides
└── .github/        # CI/CD
```

Design goals: **clone-and-run**, **automatic registration**, **single MCP entry point**,
**offline-first**, **delegation** (Figma/GitHub/Firebase stay separate MCPs, enabled
per-agent).

---

## Development

```bash
npm install
npm run build        # compile TypeScript
npm test             # smoke test (66 tools)
npm run lint         # eslint
npm run format       # prettier
make doctor          # toolchain + registration checks
```

Pre-commit hook runs `build` + `test`.

---

## Docker

```bash
docker build -t open-droid:latest .
docker run -i --rm open-droid:latest
```

> **Limitation:** the container cannot run the Android emulator. Docker Desktop on
> Windows/macOS does not expose `/dev/kvm`, and even with software rendering a
> first boot takes ~13 minutes under TCG (and `--rm` discards the AVD state, so
> every run pays that cost). The image is still useful for the MCP server's
> build/ADB/static-analysis tools.
>
> For a running emulator, use one of:
> - a **physical device**: `adb_wifi { action: "connect", host: "<phone-ip>" }`
> - a **host/WSL2 emulator**, bridged with
>   `-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037` so the MCP server's
>   `adb_devices` talks to the remote adb server.

Multi-stage build: builder (Node) compiles TS; runtime (Temurin JDK + SDK + Node).

---

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for the full checklist:
KVM permissions, architecture-mismatched AVDs, offline Gradle resolution,
`JAVA_HOME` for sdkmanager, missing optional CLIs, and OpenCode registration.

---

## Roadmap

- [ ] Multi-arch Docker images (arm64)
- [ ] Gradle wrapper in templates (fully offline builds without PATH)
- [ ] More example apps (list-detail, navigation, theming)
- [ ] Telemetry/logging improvements
- [ ] Published npm package (`android-mcp`; currently publishable via the Release workflow's `npm publish` on `v*` tags — needs an `NPM_TOKEN` secret)

---

## Contributing

See `CONTRIBUTING.md`. PRs welcome. Run `npm run build && npm test` and
`make doctor` before submitting.

---

## Security

See `SECURITY.md`. Never commit secrets; `.env` is gitignored. The MCP server
executes local shell commands — run only on trusted projects.

---

## License

MIT — see `LICENSE`.