# Open-Droid handoff (2026-10-27) — resume here

**Status:** CI green on `main` @ `b5e658c`. Approved feature NOT yet built. Everything needed to continue is committed.

## Immediate next action
1. Ask the user which execution method for the approved plan: **subagent-driven** (recommended) or **native** (superpowers:subagent-driven-development vs superpowers:executing-plans).
2. Execute `docs/superpowers/plans/2026-10-27-dynamic-analysis.md` task-by-task (11 tasks), starting with Task 1.

## The approved feature (design spec + plan, both committed)
- **Goal:** make `android-reverse-engineering` a full static→dynamic loop using the emulator (Frida + mitmproxy + runtime observation).
- **Spec:** `docs/superpowers/specs/2026-10-27-dynamic-analysis-design.md` — user decisions baked in:
  - Approach **C** (full dynamic incl. Frida)
  - `adb_shell` = **raw passthrough** (no blocklist, timeout only)
  - **`examples/vuln-app`**: deliberately-vulnerable practice app (hardcoded AES key, fake root checks, `SECRET ACCESS GRANTED` log, OkHttp fake-pin)
  - `net_capture` = **single-session** (second start → busy)
- **Plan:** `docs/superpowers/plans/2026-10-27-dynamic-analysis.md` (self-reviewed). 11 tasks:
  1. Fix `setup.sh` `$IMG_ABI`-before-definition bug (live bug; `test/setup-order.test.sh`)
  2. Vendor frida-server (17.24.3, both arches) + python venv (frida-tools, mitmproxy) into `.toolchain/`; doctor checks
  3. MCP tools `adb_shell`/`adb_logcat`/`runtime_dump`
  4. `frida-scripts/` library (6 single-file JS, `CONFIG` global, `[open-droid]` prefix)
  5. `src/frida.ts` helper (`mapAbiToAsset`, `parseBuildType`, `resolveFridaCli`, `ensureServer`)
  6. `frida_ps`/`frida_hook`/`frida_trace_methods` tools
  7. `net_capture` tool (single-session, pidfile, `10.0.2.2` proxy, CA push)
  8. Smoke test pinned to **exactly 20 tools** with per-name checks
  9. `examples/vuln-app` + CI `app-build` job (no KVM needed)
  10. `test/integration-dynamic.sh` (local, KVM-gated, exit 77 skip)
  11. Skill rewrite (3 phases + 4 workflows) + `docs/dynamic-analysis.md` + README/troubleshooting + `register.sh` refresh

## Key facts
- Push to `origin main` → watch CI with `gh run watch --exit-status <run-id>`; workflows: `mcp`, `docker`, `app-build`; Release runs only on `v*` tags (npm publish needs `NPM_TOKEN`).
- **Recurring bug pattern:** stray `EOF`/`echo done`/`npm run build` lines get appended to files written via tools — verify file tails after every write.
- `README.md` was once silently replaced by a 12-byte stub during a rebase (`git checkout --ours` kept the wrong side) — verify README stays full after any rebase.
- This host: no Docker daemon; Android toolchain NOT installed (`make setup` never completed here). User's Ubuntu host (`/home/neetigya/Open-Droid`): toolchain works, emulator needs `sudo gpasswd -a $USER kvm` + re-login.
- Skills: 35 in `skills/`, refreshed globally via `bash scripts/register.sh`.
