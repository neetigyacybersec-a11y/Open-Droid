# Open-Droid

[![CI](https://github.com/neetigyacybersec-a11y/Open-Droid/actions/workflows/ci.yml/badge.svg)](https://github.com/neetigyacybersec-a11y/Open-Droid/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-MCP-blue)](https://opencode.ai)

> **Clone. Setup once. Build Android apps offline — with a senior-level AI engineering team.**

Open-Droid is a self-contained toolkit that turns [OpenCode](https://opencode.ai) into a
full Android product studio: a single combined **MCP server** wrapping the entire
Android toolchain, a **vendored toolchain bootstrap** (fully offline after the first run),
**29 curated skills** (Android/UI, senior UI/UX design, Superpowers SDE, reverse
engineering, and an end-to-end `start-here` orchestrator), a **Material 3 Compose
starter template**, and a **self-contained Docker image**.

No scattered MCP servers. No repeated downloads. No "works on my machine."

---

## Table of contents

- [Features](#features)
- [Quick start — Docker (zero downloads)](#quick-start--docker-zero-downloads)
- [Quick start — Clone + setup (automatic registration)](#quick-start--clone--setup-automatic-registration)
- [What's included](#whats-included)
- [Skills (29)](#skills-29)
- [MCP tools (20)](#mcp-tools-20)
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
- **Self-contained Docker image** — `docker pull` and run; no host toolchain needed.
- **CI/CD** — GitHub Actions build/test on PR; on tag, publish Docker image to GHCR.

---

## Quick start — Docker (zero downloads)

```bash
docker pull ghcr.io/neetigyacybersec-a11y/open-droid:latest
```

Wire into OpenCode (`~/.config/opencode/opencode.jsonc`):

```jsonc
"mcp": {
  "servers": {
    "android-mcp": {
      "type": "local",
      "command": ["docker", "run", "-i", "--rm", "--device", "/dev/kvm", "ghcr.io/neetigyacybersec-a11y/open-droid:latest"]
    }
  }
}
```

> Shape verified against what `opencode mcp add --global` itself writes.

> Requires `/dev/kvm` on the host for emulator acceleration.

---

## Quick start — Clone + setup (automatic registration)

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
4. **Installs all 29 skills globally** into `~/.config/opencode/skills/`, so they are
   discovered everywhere.
5. Creates the project-level `.opencode/` config + skills symlink for repo-local use.

Refresh registration any time with `make register`.

---

## What's included

| Path | Purpose |
|---|---|
| `src/` | TypeScript MCP server (stdio) |
| `dist/` | Compiled server (generated) |
| `scripts/` | `setup.sh`, `register.sh`, `doctor.sh`, `new-app.sh`, `run-mcp.sh`, `warm-cache.sh` |
| `templates/compose-starter/` | Material 3 Compose starter app (AGP 8.7.2, Java 17, launcher icons) |
| `examples/hello-compose/` | Finished example app |
| `skills/` | 29 OpenCode skills |
| `docker/` | Dockerfile + entrypoint |
| `docs/` | Quickstart, architecture, offline contract, publishing, troubleshooting |
| `.github/workflows/` | CI + release pipelines |
| `Makefile` | Common tasks |

---

## Skills (29)

**Orchestrator (1):** `start-here` — idea → discovery → design → spec → TDD → review → ship

**Android / UI (8):** `android-compose-ui-ux`, `design-tokens`, `figma-to-compose`,
`android-accessibility`, `android-screenshot-diff`, `android-emulator-smoke`,
`android-gradle-troubleshoot`, `android-performance`

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

## MCP tools (20)

| Tool | Purpose |
|---|---|
| `android_env_check` | Verify toolchain + env vars |
| `gradle_task` | Run a Gradle task (`offline` supported) |
| `adb_devices` | List devices/emulators |
| `adb_screenshot` | Capture screen → returned as image |
| `adb_install` | Install APK |
| `adb_launch` | Launch app |
| `emulator_list_avds` | List AVDs |
| `emulator_boot` | Boot AVD (headless) |
| `maestro_run` | Run Maestro flow |
| `compose_preview_render` | Render Compose previews |
| `android_skills_list` / `android_skills_search` | Android CLI skills |
| `sdkmanager_install` | Install SDK packages |
| `adb_shell` | Raw shell passthrough (no blocklist) |
| `adb_logcat` | Clear, wait, dump, regex-filter |
| `runtime_dump` | dumpsys: activity/service/package/meminfo |
| `frida_ps` | Process list via frida-server |
| `frida_hook` | Spawn/attach with inline or file script |
| `frida_trace_methods` | Trace all overloads of a class's methods |
| `net_capture` | Single-session mitmproxy capture (start/stop) |

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
├── skills/         # 29 OpenCode skills
├── templates/      # Compose starter
├── examples/       # Finished sample app
├── scripts/        # setup, register, doctor, new-app, run-mcp, warm-cache
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
npm test             # smoke test (20 tools)
npm run lint         # eslint
npm run format       # prettier
make doctor          # toolchain + registration checks
```

Pre-commit hook runs `build` + `test`.

---

## Docker

```bash
docker build -t open-droid:latest .
docker run -i --rm --device /dev/kvm open-droid:latest
```

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