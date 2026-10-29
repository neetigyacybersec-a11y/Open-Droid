---
name: start-here
description: End-to-end product development orchestrator: from idea to shipped app using Superpowers, design, and SDE skills
license: MIT
compatibility: opencode
metadata:
  audience: product-teams
  platform: android
---
## What I do
Orchestrate a full professional product development cycle from a raw idea to a
shipped Android app, automatically selecting the right skills and MCP tools at
each phase. Acts like a senior product/engineering team lead.

## Phase 0 — Intake
- Capture the idea, target users, platforms, constraints, success metrics.
- Ask clarifying questions (Superpowers: brainstorming) until scope is clear.
- Produce a one-page brief.

## Phase 1 — Discovery & Design (use design skills)
- ux-research-planning: personas, journey maps, research questions.
- usability-testing: test plan template.
- android-compose-ui-ux: visual system, M3 tokens, motion, adaptive layouts, foundations (consolidated).
- design-tokens: tokens + theming.
- content-design-microcopy: copy guidelines.
- figma-to-compose: handoff mapping via Figma MCP (get_design_context, get_variable_defs, get_screenshot).
- Produce wireframes/prototypes in Figma; review with design-critique.

## Phase 2 — Specification (use SDE skills)
- domain-modeling: ubiquitous language + bounded contexts.
- codebase-design: module boundaries and deep modules.
- writing-plans: implementation plan with TDD steps.
- to-spec / to-tickets: convert to tickets.

## Phase 3 — Implementation (use coding skills)
- using-git-worktrees: isolated workspace.
- subagent-driven-development / dispatching-parallel-agents: parallel tasks.
- test-driven-development: red-green-refactor per task.
- android-gradle-troubleshoot: build issues.
- android-accessibility: accessibility as you build.
- android-emulator-smoke: run on device.

## Phase 4 — Review & QA
- requesting-code-review / receiving-code-review: code review.
- design-critique: UI review.
- android-screenshot-diff: visual regression baselines.
- android-accessibility: accessibility audit.
- wcag-audit: WCAG conformance audit.
- usability-testing: run real tests; capture SUS/task success.
- For reverse engineering / dynamic analysis of a shipped APK, use `android-reverse-engineering` (Frida + mitmproxy on emulator).

## Phase 5 — Verification & Ship
- verification-before-completion: run all tests, lint, build.
- finishing-a-development-branch: merge/PR decision.
- android-performance: baseline profiles, benchmarks.
- android-reverse-engineering: if analyzing third-party deps.

## MCP tools used
- Figma MCP: get_design_context, get_variable_defs, get_screenshot, use_figma.
- Android MCP: android_env_check, gradle_task, adb_*, emulator_*, maestro_run.
- GitHub MCP: issues, PRs, code search.
- Context7: library docs.

## How to use me
Invoke this skill at the start of any new product or feature. I will walk through
phases 0-5, pulling in the relevant skills and MCP tools, asking questions, and
producing artifacts (brief, personas, wireframes, plan, code, tests, PR).

## When to use me
Use when starting a new app or major feature and you want a professional,
end-to-end development process.
