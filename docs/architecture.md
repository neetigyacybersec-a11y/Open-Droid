# Architecture

## Components

- **MCP server** (`src/`) — TypeScript, stdio transport, wraps the Android toolchain.
- **Toolchain** (`.toolchain/`, gitignored) — vendored JDK, Android SDK, Gradle, Maestro, skills repo. Produced by `make setup`.
- **Templates** (`templates/`) — starter Compose apps.
- **Skills** (`skills/`) — OpenCode SKILL.md files for Android/UI workflows.
- **Docker image** — self-contained runtime with everything preinstalled.

## Runtime safety boundaries

Dangerous operating-system capabilities are not implemented in tool handlers.
Handlers validate and describe an operation, then call one of the approved
services below. `npm run architecture` enforces this contract in CI: it scans
`src/**/*.ts` and fails on any `node:child_process` import or raw
`exec`/`execSync`/`spawn`/`execFile` call outside the allowlist. ESLint's
`no-restricted-imports` rule reports the same import at edit time.

| Boundary | Owns | Must not |
| --- | --- | --- |
| `src/services/process-runner.ts` | Host execution through argv arrays, working directory, timeout, output caps, exit code/signal reporting. | Accept shell command strings or interpret stderr as success. |
| `src/services/managed-process.ts` | Detached child lifecycle: spawn errors, readiness, identity, bounded SIGTERM→SIGKILL shutdown. | Signal a PID it did not spawn. |
| `src/services/adb-client.ts` | Device selection as an argv pair, remote-shell quoting, destructive-path/intent/component validation, activity resolution to `package/class`. | Concatenate device input into a host shell string. |
| `src/executionPolicy.ts` + `src/boundary.ts` | #50 policy/approval decisions and request-scoped workspace path checks at the server boundary. | Rely on skill instructions or previews as enforcement. |
| `src/workspace.ts` | Canonical path scope for read/write/delete arguments, including symlink resolution. | Treat string prefixes as containment. |

`src/tools.ts` still composes device commands from fixed Android command
grammar plus values that pass the `adb-client` validators or `shquote`. It does
not implement a second process runner. APK serving stages only regular APK
files into a private directory before binding the listener (Issue 91).

### Exceptions

Build and test tooling under `scripts/` and `test/` may use Node APIs directly;
it is not part of the MCP runtime. A new runtime exception requires a narrow
written rationale, an update to `APPROVED_PROCESS_FILES` in
`scripts/check-architecture.mjs`, and Code Owner review under Issue 93. Do not
create a generic framework to avoid a rule: add the smallest domain service
that owns the capability.

## Design goals

1. **Clone-and-run**: after `make setup` (or `docker pull`), no network access required.
2. **Single MCP entry point**: one server instead of 8–10, reducing context cost.
3. **Delegation**: capabilities not implemented here (Figma, GitHub, Firebase, etc.) remain separate MCPs, enabled per-agent.
