# Dependency and build-system review

Issue 107 adds a read-only checker for dependency, plugin, repository, wrapper,
toolchain and lockfile changes. It exists because an AI agent or a routine
source review can miss a build-system edit that executes code, redirects an
artifact, or silently changes the resolved dependency graph.

The checker is `scripts/dependency-review.mjs`. It is dependency-free, performs
no network access by default, and never installs or resolves dependencies.

## Running it

```bash
# Human-readable review of the current branch against main.
npm run dependency-review -- --base origin/main --format markdown

# Machine-readable report.
node scripts/dependency-review.mjs --base origin/main --format json

# Release evidence: deterministic SBOM plus a review report.
node scripts/dependency-review.mjs --base "$(git describe --tags --abbrev=0)" \
  --format json --sbom dist/sbom.cdx.json --audit

# Fail CI at medium risk (default threshold is high).
node scripts/dependency-review.mjs --base origin/main --fail-on medium
```

`--base` is required. The checker inspects committed changes from the resolved
base commit through `HEAD`; untracked and unstaged work is not reviewed.

| Option | Meaning |
| --- | --- |
| `--base <revision>` | Required base commit-ish to compare with `HEAD`. |
| `--format json\|markdown` | Stable JSON (schema version 1) or Markdown. |
| `--fail-on high\|medium\|low\|none` | Exit `1` at or above this risk. Default `high`. |
| `--sbom <path>` | Write a deterministic CycloneDX 1.5 SBOM. |
| `--audit` | Run `npm audit --package-lock-only --ignore-scripts` for the HEAD lockfile. |

Exit codes:

- `0` — below the configured threshold, or `--fail-on none`.
- `1` — highest finding is at or above the threshold.
- `2` — operational failure (bad arguments, unresolved base, unreadable git
  data, SBOM write failure). Standard output stays empty.

## What is monitored

Every matching file at any depth is inspected, except generated trees such as
`node_modules`, `.git`, `.gradle`, `build`, `dist` and `out`.

- npm: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
  `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`.
- Gradle: `build.gradle(.kts)`, `settings.gradle(.kts)`, `gradle.properties`,
  `gradle/*.versions.toml`, `gradle-wrapper.properties`,
  `gradle-wrapper.jar`, `gradle/verification-metadata.xml`, and
  `*.lockfile`/`dependencies.lock`.
- Maven: `pom.xml` is surfaced as a build-file change for the same review.

A changed file is reduced to findings with a stable shape: file, git status,
kind, ecosystem, change type, section, coordinate, old/new value, risk, review
flag, reason, evidence pointer and details. Findings are sorted before IDs are
assigned, so identical inputs produce identical JSON and Markdown.

## Risk policy

| Change | Risk |
| --- | --- |
| New npm/Gradle direct dependency | Medium |
| Dependency removal | Low |
| Major version update | Medium |
| Minor or patch version update | Low |
| New build plugin, or plugin version change | High |
| New custom, insecure, local or credential-bearing repository | High |
| Standard repository (`google()`, `mavenCentral()`, Gradle Plugin Portal) | Low |
| New npm `overrides`/`resolutions` entry | High |
| Local file or binary dependency | High |
| Buildscript classpath dependency | High |
| Gradle wrapper properties or wrapper JAR change | High |
| Java, Android SDK, NDK, build-tools or Compose compiler version change | High |
| Gradle verification metadata change | High |
| npm registry over HTTP or credential-bearing npm config | High |
| Ordinary npm config change | Medium |
| Priorities, tooling and lockfile-only changes | Medium |
| Unrecognized build logic containing exec/download patterns | High |
| Other unrecognized build logic | Medium |
| Deleted manifest, catalog, build or settings file | High |
| Maven build-file change | Medium |

`review` is true for medium and high findings. `summary.reviewRequired` is true
when any finding needs review.

### Bypass resistance

- The checker does not only look at a fixed set of root files; package
  manifests, catalogs, lockfiles, wrapper files and build scripts are matched
  at any depth.
- Version-catalog edits are resolved to effective `group:artifact` and plugin
  IDs, so changing only `gradle/libs.versions.toml` still reports the affected
  dependency or plugin.
- Build files that reference catalog aliases (`implementation(libs.x)`,
  `alias(libs.plugins.x)`) are resolved to the same effective coordinates, so
  adding only an alias cannot hide a dependency or plugin.
- Lockfile-only edits are explicit (`lockfile-only`) instead of disappearing as
  unexplained build noise.
- Unrecognized build logic is reported rather than ignored; suspicious
  exec/download patterns fail closed at high risk.
- Removing a primary manifest, catalog, build or settings file is high risk.
- URL credentials are stripped from the report, and common credential fields
  are redacted.

## Reuse and equivalence

New direct dependencies carry `equivalenceCandidates` when the same module is
already declared in an unchanged project file. A catalog declaration is
reported as `exact-module`; an npm declaration elsewhere is `same-package`.
`summary.reuse.addedDirect` counts new direct declarations and the message asks
authors to state why a new dependency is needed.

Candidates are evidence, not an automatic replacement. The checker never edits
manifests or resolves a version range.

## Supply-chain status is honest

- `summary.license.status` is `pass`, `fail` or `unknown`. npm licenses are read
  from `node_modules/<name>/package.json` at HEAD; a missing package is
  `unknown`, never a pass. Gradle license metadata is `unknown` unless local
  metadata is available, because the checker does not resolve the Gradle graph.
- `summary.advisories.status` is `unavailable` unless `--audit` succeeds. A
  failed or empty `npm audit` is `unavailable`, never `pass`. With `--audit`,
  high/critical counts also create a high-risk finding.
- `summary.sbom.status` is `unavailable` unless `--sbom` is passed. The written
  CycloneDX 1.5 document has no timestamp, so repeated runs are byte-identical.

These summaries are advisories for reviewers. They do not replace a full
dependency-resolution audit or a legal license review.

## CI and human review

`.github/workflows/ci.yml` runs the checker in the `dependency-review` job with
full git history. Pull requests diff against the PR base commit; pushes diff
against `github.event.before`, with a root-commit fallback for a new branch or
an all-zero before SHA. The Markdown report is written to the job summary even
when the job fails, and the checker exit status still fails the build.

`.github/CODEOWNERS` names an owner for npm manifests and lockfiles, Gradle
build/settings/catalog/properties/wrapper/verification files, npm configuration,
Maven builds and CI workflows. **This only routes review when branch protection
or a repository ruleset requires code-owner review.** A CODEOWNERS file by
itself does not block a merge.

## Relationship to other guardrails

This checker is the diff gate for the files listed above. It is intentionally
standalone: it does not duplicate the project preflight (#100) or the
declarative tool registry (#104), which own project-orientation and tool
classification respectively. When those land, they should consume this report
or invoke the checker rather than reimplementing a second dependency policy.

## Determinism and side effects

- The checker reads git objects only. It does not write to the worktree (except
  an explicitly requested SBOM path), install packages or alter lockfiles.
- Report JSON contains no timestamps, absolute paths from the inspected tree or
  unordered collections.
- Findings are sorted by file, change type, coordinate and values; IDs are
  assigned after sorting.

## Limitations

- Gradle files are matched line-by-line. The checker does not evaluate a Gradle
  model, so generated build logic, arbitrary Kotlin DSL control flow, included
  builds outside the repository and dynamically computed coordinates can be
  missed or misclassified. Such lines are reported as unrecognized build logic
  when they change.
- npm and Gradle lockfiles are compared as text models; transitive graphs are
  not resolved or verified against public advisory or license databases.
- Release freshness is not looked up. The report does not guess whether an
  upstream package is unmaintained; that remains a reviewer question.
- Maven `pom.xml` changes are surfaced but not decomposed into dependencies.
- Only committed changes are reviewed. Untracked files, unstaged edits and
  submodule contents are out of scope.
- `--audit` requires network access and a `package-lock.json`; an offline or
  unsupported audit is reported as `unavailable`, not as a clean result.
- License and advisory summaries are best-effort evidence. They do not prove a
  dependency is safe, and `unknown` is not a pass.
- Branch protection, not this script or CODEOWNERS, is the enforcement point
  for required human approval.
