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

## Minimal-change engineering contract
- Read the relevant code, tests, and existing implementation before editing.
- Search for existing helpers, validators, services, patterns, and dependencies before introducing another.
- State the specific behavior being changed and its acceptance criteria.
- Modify only files required for that behavior, plus focused tests and docs.
- Avoid opportunistic refactors. If a refactor is genuinely required, explain why and keep it within the same coherent boundary.
- Avoid introducing a dependency for functionality already available in Node.js, TypeScript, or existing dependencies.
- Avoid new generic abstractions with one trivial caller unless they materially improve safety or isolate a risky boundary.
- Avoid duplicate validation, duplicate state, wrapper-on-wrapper patterns, and speculative configuration options.
- Preserve public interfaces unless the issue explicitly requires a change.
- Avoid unrelated formatting churn; format touched files or use a separately scoped formatting-only change.
- Add regression tests for changed behavior, not tests that merely assert source strings.
- Report what was not tested or could not be verified.
- Bug-fix default: encode the failing behavior in a regression test, make the narrow fix, run focused tests, then run the full verification command.
- Complexity budgets: cyclomatic complexity 12, nesting 4, function length 80 lines by default; exceptions must be local, explained, and reviewable. Existing legacy debt is ratcheted, not fixed as unrelated churn.

## Do not
- Commit `.toolchain/`, `node_modules/`, `dist/`, or secrets.
- Add MCP servers that duplicate existing capabilities; prefer extending this one.
