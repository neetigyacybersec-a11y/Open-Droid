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
- [MCP tools (75)](#mcp-tools-75)
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
>
> **Windows / restricted PowerShell:** use `node scripts/build.mjs`,
> `node scripts/test.mjs` and `node scripts/doctor.mjs`; `make` and the `.sh`
> entry points require Git Bash or WSL2. See [docs/windows.md](docs/windows.md).

```bash
git clone https://github.com/neetigyacybersec-a11y/Open-Droid.git
cd Open-Droid
export ANDROID_MCP_WORKSPACE="$PWD"   # required: MCP path tools fail closed without it

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
| `scripts/` | `setup.sh`, `register.sh`, `doctor.sh`, `new-app.sh`, `run-mcp.sh`, `warm-cache.sh`, `pack-warm.sh`, `packs-proof.sh`, `repo-hygiene.sh` |
| `templates/compose-starter/` | Material 3 Compose starter app (AGP 8.7.2, Java 17, launcher icons) |
| `examples/hello-compose/` | Finished example app |
| `examples/packs-reference/` | Reference consumer that builds every dependency pack offline (FR-R1) |
| `skills/` | 30 OpenCode skills |
| `docker/` | Dockerfile + entrypoint |
| `docs/` | Quickstart, architecture, quality gates, offline contract, publishing, lifecycle coverage, compose previews, troubleshooting |
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

## MCP tools (75)

The server exposes 75 tools grouped by category. The full list with schemas is
returned by `tools/list` (MCP); [`docs/tool-catalogue.md`](docs/tool-catalogue.md)
is generated from the typed registry and records each tool's risk class,
approval requirement, path policy and tests. `docs/agent-install.md` covers
installation, registration, and verification.

| Category | Count | Examples |
|---|---|---|
| Environment | 2 | `android_env_check`, `sdkmanager_install` |
| Build | 9 | `gradle_task`, `gradle_test`, `build_variant`, `android_project_inspect`, `android_release_notes_generate` |
| ADB | 26 | `adb_devices`, `adb_screenshot`, `adb_shell`, `adb_logcat`, `adb_parallel` |
| Emulator / AVD | 6 | `emulator_list_avds`, `emulator_boot`, `avd_create`, `avd_wipe` |
| Frida (dynamic) | 3 | `frida_ps`, `frida_hook`, `frida_trace_methods` |
| Network exposure | 2 | `net_capture`, `apk_serve` |
| UI inspection | 5 | `ui_dump`, `compose_recomposition`, `layout_bounds` |
| Static analysis | 5 | `apk_info`, `apk_decompile`, `manifest_inspect`, `native_libs`, `dex_strings` |
| Testing | 7 | `maestro_run`, `instrumented_test`, `android_test_failure_analyze`, `android_flaky_test_history` |
| Profiling | 3 | `perfetto_trace`, `memory_profile`, `startup_time` |
| Privacy | 1 | `privacy_scan` |
| Security | 3 | `secret_scan`, `security_audit`, `policy_preflight` |
| Skills | 2 | `android_skills_list`, `android_skills_search` |
| Catalogue | 1 | `tool_catalog` (safe-only discovery with risk and approval metadata) |

Run `tools/list` for the exact schema of every tool, or `tool_catalog` with
`safeOnly: true` to see only approval-free tools that can run unattended.

**Not registered:** `screenshot_diff`, `design_qa_matrix` and `a11y_audit` are
planned, not callable. Use `adb_screenshot` and `compose_preview_render` for
captures today, and Roborazzi screenshot/accessibility checks inside app tests.
The generated catalogue's [planned section](docs/tool-catalogue.md#planned-not-registered)
records their tracking issues.

### Capture archive and golden baselines

`adb_screenshot` and `adb_screenrecord` now persist captures by default into a
server-owned archive instead of the OS temp directory. Names are self-describing
(`screenshot-<device>-<package>-<epoch>.png`), the saved path is returned with the
inline image, and the archive is capped so it cannot grow without bound.

- `ANDROID_MCP_CAPTURES_DIR` — archive location (default `~/.android-mcp/captures`).
- `ANDROID_MCP_CAPTURES_KEEP` — archived captures to retain (default `200`).
- Pass `transient: true` or an explicit `outputPath` to `adb_screenshot` for the
  old inline-only or caller-chosen-path behavior.

`adb_screenshot` still returns the PNG inline; `screenshot_baseline_save <name>`
adopts a capture (or takes a fresh one) as a named baseline with sha256 metadata,
and `screenshot_baseline_list` reports the stored baselines. Baselines are kept
separately from the rolling capture archive and are never auto-pruned. The planned
`screenshot_diff` tool will resolve baselines by name from this archive.

### Release notes drafts

`android_release_notes_generate <projectPath> <baseRef> [headRef]` drafts notes
from a real Git ref range. Every item carries a source commit reference, and
user-facing notes, fixes, breaking changes and engineering summaries are kept
in separate sections. Subject-only fix/feature claims, unclassified commits and
empty ranges are flagged for review instead of being invented. Secrets and
internal hostnames are redacted; `locales` records translation debt rather than
claiming translated copy. The tool is read-only: it writes no files and never
publishes to the Play Console.

### Test failure diagnosis

`android_test_failure_analyze` parses JUnit XML and correlates optional logcat,
Gradle, emulator and screenshot evidence. Its report separates observed failure
and stack lines from confidence-labelled hypotheses and explicit unknowns, and
returns an "insufficient evidence" state rather than guessing a root cause.
`android_flaky_test_history` keeps outcomes in a local, bounded store and calls
a test flaky only after repeated inconsistent results under the same test ID and
environment dimensions. `android_test_failure_bundle` writes a redacted,
inspectable markdown bundle with metadata and evidence paths for issue/PR
attachment. Tokens, internal hosts and user home paths are redacted by default;
nothing is sent to an external service. Outcome history and bundles live under
`ANDROID_MCP_TEST_HISTORY_DIR` (default `~/.android-mcp/test-history`), with
`ANDROID_MCP_TEST_HISTORY_KEEP` bounding retained outcomes and
`ANDROID_MCP_TEST_EXCLUDE_IDS` accepting comma-separated test IDs or `*` globs
to exclude from flaky evaluation.

### Project inventory

`android_project_inspect` inventories a Gradle Android project: module paths
and types, SDK levels and namespace, application ID, version codes, product
flavors, build types, source-set directories, manifests and dependency
summaries — plus version-catalog location and malformed-config errors, all as
read-only evidence. Fields that cannot be statically parsed are reported as
unknowns with their source file rather than guessed. Only file names (not
contents) of sensitive files like `local.properties`, keystores and `.env` are
listed. The tool never runs builds, resolves dependencies, or modifies files.


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

Headless Compose previews (no emulator):

```bash
compose-preview show --project templates/compose-starter --json
```

The `compose_preview_render` MCP tool wraps that command, verifies the PNGs and
returns them inline. See [docs/compose-preview.md](docs/compose-preview.md).

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
npm test             # smoke test (75 tools)
npm run architecture # enforce approved process/ADB boundaries
npm run catalogue    # verify docs/tool-catalogue.md matches src/registry.ts
npm run lint         # one timed, type-aware eslint pass
npm run quality      # complexity ratchet + suppression policy
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

### Workspace and tool-output policy

Every filesystem argument is checked in the execution layer before a handler
runs. The server fails closed: set `ANDROID_MCP_WORKSPACE` to the project root,
or `ANDROID_MCP_WORKSPACE_ROOTS` to a `path.delimiter`-separated list of
approved additional roots, before using project, APK, flow, report or output
tools. The OS temp directory is approved for tool-owned output. Paths outside
those roots are blocked unless the caller supplies a request-scoped grant, and
`overwrite: true` is required to replace an existing file.

Tool output from projects, Gradle, adb/logcat, APKs, Frida and network capture
is framed as untrusted data and returned with `_meta.provenance`; MCP policy
decisions are structurally separate. ANSI/C0/C1 controls are stripped, obvious
credentials are redacted, and large output is truncated with an explicit
marker (`ANDROID_MCP_MAX_OUTPUT_CHARS` raises the default bound). These labels
are one defense layer, not a guarantee against prompt injection, and this
workspace policy is not an OS or container sandbox. It does not constrain an
external coding agent editing files on its own. See [SECURITY.md](SECURITY.md).

Each invocation emits one `event=tool.start` and one `event=tool.end` record to
stderr with a unique correlation ID, tool, duration, source category and a
truthful outcome (`success`, `failed`, `blocked`, `unavailable`, `timeout`,
`partial`, `cancelled`). Diagnostics are one redacted, bounded line; raw
arguments, scripts and full tool output are not logged. The same correlation ID
is returned in `_meta.correlationId` for cross-referencing.

The typed tool registry in `src/registry.ts` records each tool's risk class,
approval requirement, side effects, preconditions, path policy and test
references. `tool_catalog` returns that metadata and can filter to the
`approval: none` + unattended subset for clients that want a conservative
starting point. That view is advisory: the execution boundary still enforces
the workspace policy for every call.

### Execution policy and approvals

A separate execution policy decides whether a tool may run, needs a bound
approval, or is refused. The default is `balanced`: approval-free inspection
runs, while destructive, device-state, network-exposure, external-write and
publish-like operations need a single-use HMAC token. `restricted` limits work
to read-only tools plus an explicit `ANDROID_MCP_ALLOW` list; `permissive` keeps
the expert escape hatch with explicit warnings. A blocked call returns a
preview and an encoded request that a human can sign out of band with
`npm run approve -- '<request>'`; no confirmation UI is claimed.

Configuration, the impact table, the approval workflow, audit fields and the
limits of this guardrail are documented in
[docs/execution-policy.md](docs/execution-policy.md).

### Dependency and build-system review

`scripts/dependency-review.mjs` inspects npm manifests, lockfiles, Gradle
build/settings/catalog/wrapper/verification files and npm configuration changes.
It reports new or changed dependencies, plugins, repositories, overrides,
toolchains and lockfile-only edits with a risk level, and CI fails on high-risk
changes. The checker is read-only and never installs dependencies. CODEOWNERS
routes the protected files to review, but branch protection is required to make
that approval mandatory. Policy, risk table and limitations:
[docs/dependency-review.md](docs/dependency-review.md).

---

## License

MIT — see `LICENSE`.