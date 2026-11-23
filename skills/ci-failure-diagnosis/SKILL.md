---
name: ci-failure-diagnosis
description: Diagnose CI build/test failures using GitHub Actions logs and local-log mode for other CI systems. Use when CI is red, a user pastes a CI failure, or an agent needs a root-cause report with reproduction steps.
license: MIT
compatibility: opencode
metadata:
  audience: engineering
  stack: ci
---

## What I do

Collect CI failure evidence and produce a classified diagnosis report:

1. **Collect** — from a GitHub Actions run URL via the gh CLI (official API):
   run/job/step metadata, failed-job logs, commit SHA, run URL. For other CI
   systems: a local-log mode that scans a directory of CI logs.
2. **Classify** — extract failing test IDs, messages and stack lines from
   logs, and label the cause `confirmed` / `likely` / `unknown` with
   evidence and a repro command. Common classes: dependency resolution,
   Gradle config, Kotlin compile, lint, unit test, emulator startup,
   instrumentation, Maestro, signing, artifact upload, unknown.
3. **Redact** — tokens, PATs, Bearer JWTs, signing material, internal
   hostnames and private IPs are removed before any excerpt is reported.

## When to use me

- A CI check is red and the user pastes a failure URL or says "diagnose the CI failure".
- A failing log was exported to a local file/dir (non-Actions CI systems).
- Reproduction is unclear and you need a bounded, redacted report with next steps.

## How to use me

```sh
# GitHub Actions (reads via gh CLI — never pushes or reruns anything)
node scripts/ci-failures.mjs --run "https://github.com/owner/repo/actions/runs/12345678"

# Local logs from any CI system
node scripts/ci-failures.mjs --local /tmp/ci-logs
```

Rules I follow:

- Evidence first: read run → job → step → log via `gh api`; never guess.
- Never relabel a failure confirmed without evidence; `unknown` is honest.
- Never rerun workflows or commit/push without explicit user approval.
- Never modify files (read-only collection).

If the run URL is missing or unreadable, report the reason and ask for the run
URL or a local log directory.

## Output contract

Report shape (text): `status`, `collected`, `url`, `runId`, `commit`,
`failedJobs`, per-failure `kind`/`label`/`excerpt`/`evidence` (testId, message,
stackLines), `repro`, bounded `excerpt`. Evidence is redacted by default.

## Uncertainty protocol

Say "not confirmed" or "likely" when you can't prove it; never invent causes
from a log that doesn't show them. Empty/missing logs are `status=error` with
a reason — not a passing build.

## Related

- `android_test_failure_analyze` — JUnit/Gradle failure analysis (unit-level).
- `android_test_suite_run` — run configured test suites locally.
