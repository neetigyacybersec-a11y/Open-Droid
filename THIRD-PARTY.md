# Third-party content

This repository borrows skills from upstream projects. Attribution:

## Superpowers (SDE skills)
Source: https://github.com/obra/superpowers (npm: superpowers@7.0.1)
Skills copied verbatim into `skills/`:
brainstorming, dispatching-parallel-agents, executing-plans,
finishing-a-development-branch, receiving-code-review, requesting-code-review,
subagent-driven-development, systematic-debugging, test-driven-development,
using-git-worktrees, verification-before-completion, writing-plans, writing-skills.

## reverse-engineer-anything
Source: rea-agents (npm: rea-agents@6.3.0), skill `reverse-engineer-anything`.
Copied verbatim into `skills/reverse-engineer-anything/`. Extended by
`skills/android-reverse-engineering/`.

## Android skills (runtime, not vendored)
Source: https://github.com/android/skills (Google). Cloned into `.toolchain/android-skills`
by `make setup`. Not committed.

All borrowed content retains its original license. Verify upstream licenses before
redistribution.
