# Architecture

## Components

- **MCP server** (`src/`) — TypeScript, stdio transport, wraps the Android toolchain.
- **Toolchain** (`.toolchain/`, gitignored) — vendored JDK, Android SDK, Gradle, Maestro, skills repo. Produced by `make setup`.
- **Templates** (`templates/`) — starter Compose apps.
- **Skills** (`skills/`) — OpenCode SKILL.md files for Android/UI workflows.
- **Docker image** — self-contained runtime with everything preinstalled.

## Design goals

1. **Clone-and-run**: after `make setup` (or `docker pull`), no network access required.
2. **Single MCP entry point**: one server instead of 8–10, reducing context cost.
3. **Delegation**: capabilities not implemented here (Figma, GitHub, Firebase, etc.) remain separate MCPs, enabled per-agent.
