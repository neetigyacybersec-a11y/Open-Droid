# Quality gates

Issue 95 turns the existing TypeScript, ESLint and formatting checks into a
deterministic policy for new code. The goal is to reject common sloppy patterns
with a precise location, not to demand code golf or an arbitrary file-size
ceiling.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | Compile `src/` with `tsc`. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | One timed, type-aware ESLint pass over `src/`. |
| `npm run quality` | Complexity ratchet plus the suppression policy. |
| `npm run format:check` | Prettier check for `src/`. |

`scripts/lint.mjs` prints `[android-mcp] eslint OK|FAILED in N.Ns`. CI records
that line and the per-step duration; type-aware linting is invoked once per job
(the Linux `mcp` job and the Windows `mcp-windows` job each run it exactly
once).

## TypeScript and ESLint rules

- `strict: true` remains enabled in `tsconfig.json`.
- `@typescript-eslint/no-explicit-any` is `error`; no blanket exemption remains.
- Type-aware `@typescript-eslint/no-floating-promises`,
  `@typescript-eslint/no-misused-promises` and
  `@typescript-eslint/no-unnecessary-type-assertion` are `error`.
- `no-restricted-imports` keeps `node:child_process` inside the approved
  services described in `docs/architecture.md`.

Use `unknown` plus narrowing, generics, or SDK-provided types instead of `any`.
`src/outcome.ts` and `src/executionPolicy.ts` show the intended pattern for
untyped MCP payloads: normalize once with a record helper, then narrow.

## Complexity budgets

`scripts/check-complexity.mjs` measures every function in `src/`:

| Metric | Limit |
| --- | --- |
| Cyclomatic complexity | 12 |
| Nesting depth | 4 |
| Function body | 80 lines |

Existing debt is recorded in `scripts/quality-baseline.json`, keyed by
`file::function` with the recorded metric values. The checker permits a value
at or below the baseline and fails on a new function, an increased metric, or a
missing baseline file. When a module is touched, reduce its debt and lock the
improvement in:

```bash
node scripts/check-complexity.mjs --update-baseline
```

Review the baseline diff before committing: it must only lower or remove
entries, never add or raise one for existing behavior. The 80-line limit is a
review trigger, not a reason to split cohesive modules artificially.

## Suppressions

`scripts/check-suppressions.mjs` scans `src/`, `test/` and `scripts/`.

- Blanket file-level `eslint-disable` and `@ts-nocheck` are rejected.
- A suppression must name its rule(s) and carry a nearby `-- reason`.
- Keep exceptions to one line or a named block.

Accepted:

```ts
// eslint-disable-next-line no-control-regex -- ANSI controls are the input
const ansi = /\u001b\[[0-9;]*m/;
```

Rejected:

```ts
/* eslint-disable */
// @ts-ignore
// eslint-disable-next-line no-explicit-any
```

## Fixtures

`test/quality.test.mjs` exercises the public checker seams and the real ESLint
configuration:

- `test/fixtures/quality/rejected.ts` proves `any`, a floating promise, a
  misused promise and an unnecessary assertion fail.
- `test/fixtures/quality/allowed.ts` proves `unknown` narrowing and awaited
  promises pass.
- Generated source snippets prove the cyclomatic, nesting and line budgets and
  the baseline comparison, including the reported file and function.

## Platform notes

`scripts/lint.mjs` and `scripts/quality.mjs` invoke Node directly, so they work
under Windows PowerShell without relying on `npm.ps1`. The Windows CI job runs
the same checker scripts as Linux. There is no platform-specific exception.

## Limits

- The baseline is legacy debt, not an endorsement. It must ratchet down as
  modules change.
- Code Owner review for lint configuration and this policy is declared in
  `.github/CODEOWNERS`; live enforcement still depends on the repository
  ruleset tracked by Issue 93.
- Static budgets cannot prove behavior. Handler and policy tests remain the
  correctness boundary.
