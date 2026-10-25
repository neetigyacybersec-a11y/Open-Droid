# android-mcp

Combined Android development MCP server + product toolkit.

## Quick start
- `make setup` — one-time toolchain download into `.toolchain/` (offline afterwards).
- `make doctor` — verify toolchain + MCP build.
- `make build-mcp` — build TypeScript MCP server.
- `make run-mcp` — run MCP server on stdio.
- `make new-app NAME` — scaffold a Compose app from `templates/compose-starter`.

## Conventions
- Skills live in `skills/<name>/SKILL.md`; OpenCode discovers them via `.opencode/skills` symlink.
- Toolchain is vendored under `.toolchain/` (gitignored). Never commit it.
- Keep MCP tools thin wrappers over shell/CLIs; design judgment lives in skills.
- Run `npm test` (smoke) before committing changes to `src/`.

## Do not
- Commit `.toolchain/`, `node_modules/`, `dist/`, or secrets.
- Add MCP servers that duplicate existing capabilities; prefer extending this one.
