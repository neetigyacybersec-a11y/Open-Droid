# Contributing

1. Fork and clone.
2. `make setup` (one-time).
3. Create a branch; make changes.
4. `npm run build && npm test` must pass.
5. `make doctor` must be green.
6. Open a PR; CI will build Docker + run tests.

## Dependency and build-system changes

Run `npm run dependency-review -- --base origin/main` before opening a PR when
you touch npm manifests, lockfiles, Gradle build/settings/catalog/wrapper files,
npm configuration or CI workflows. CI also runs the checker and fails on high
risk. State why any new direct dependency is needed and prefer an existing
project declaration; see `docs/dependency-review.md` for the risk policy and
the human-review requirements.

## Adding a skill
Create `skills/<name>/SKILL.md` with `name` (lowercase, hyphenated) and `description` frontmatter. Name must match the directory. Run the skill-name validation (see `scripts/`).

## Adding an MCP tool
Add to `src/tools.ts` (schema + handler) and register in `src/index.ts`. Keep handlers thin and validate inputs.
