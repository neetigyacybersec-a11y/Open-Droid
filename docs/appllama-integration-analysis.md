# Appllama skills — integration analysis & skill-bloat audit

## 1. What was analyzed

- Repo: `git@github.com:Appllama/appllama-skills.git` (cloned to `/tmp/opencode/appllama-skills`, shallow).
- License: MIT (Copyright 2026 Antmind Ventures Pvt Ltd). Reuse permitted with attribution. Appllama name/logo are trademarks — not granted.
- Contents: 2 skills (`appllama-usage`, `appllama-app-design-skill`) + an MCP server (https://mcp.appllama.io/mcp) + plugin manifests for Claude Code / Cursor.

## 2. What Appllama provides

| Skill | Focus | Stack assumed |
|---|---|---|
| `appllama-usage` | Research engine: query Appllama MCP (top-grossing apps, screens, flows, UI elements), build-from-research playbooks | Requires Appllama MCP (paid Pro, 1500 credits/mo) |
| `appllama-app-design-skill` | Build bar: native-feeling mobile screens, Apple HIG fidelity, Reanimated motion, navigation laws, anti-slop, simulator loop | Expo + React Native + TypeScript, iOS Simulator |

## 3. Fit against this project (android-mcp)

This project is an **Android** MCP toolkit: Kotlin/Compose, Gradle, ADB, emulator, Material 3, offline-first vendored toolchain. Mismatches:

- **Stack mismatch:** Appllama targets Expo/React Native + iOS HIG (SF Symbols, Dynamic Island, `expo-router`, Reanimated). Our UI stack is Jetpack Compose + Material 3. The skill's concrete guidance (Reanimated springs, expo-image, SF Symbols) would mislead an agent building Compose UI.
- **Runtime dependency:** Appllama MCP is a paid, network-only service. Our project is explicitly offline-first (vendored toolchain, zero downloads after setup). Adding a paid MCP dependency contradicts that.
- **Simulator vs emulator:** Appllama's verification loop is iOS Simulator (`xcrun simctl`). Our verification is Android emulator (ADB, KVM). Different tooling.
- **Bloat:** We had 35 skills at audit time (29 after the consolidation in section 5), 13 of them design/UI-focused with heavy overlap. Adding 2 more design skills would worsen the paradox of choices.

## 4. Decision (updated)

**Integrated.** User requested deep integration of Appllama's skills. Done:
- Copied `appllama-usage` and `appllama-app-design-skill` into `skills/` (now 31 skills).
- Added the Appllama MCP to `.opencode/opencode.jsonc` (disabled by default; enable after connecting an Appllama account).
- Wired into `start-here` skill (design-research phase) and README.
- Updated `docs/agent-install.md` (Appllama MCP section).

Notes / caveats (preserved from the analysis):
- Stack mismatch remains: Appllama targets Expo/React Native + iOS HIG; our UI stack is Compose + Material 3. The skills are kept verbatim (not rewritten) and are most useful for cross-platform/Expo work or design research; they are NOT a Compose implementation guide.
- Paid, network-only MCP: disabled by default; enable only with an Appllama Pro account. Does not affect offline-first core.
- Skill count 29 → 31 (acceptable; user explicitly requested).

## 5. Skill-bloat audit (35 skills at audit time; consolidation executed)

### Overlap clusters

**Design/UI (13 skills, heavy overlap):**
android-compose-ui-ux, android-material3-design, android-design-tokens, design-system-tokens, motion-design, uiux-design-foundations, compose-accessibility, android-accessibility-audit, content-design-microcopy, design-critique, figma-to-compose, wcag-audit, android-adaptive-layouts

**UX research (4):** usability-testing, ux-research-planning, content-design-microcopy, design-critique (overlap)

**Reverse engineering (2):** android-reverse-engineering, reverse-engineer-anything (different scope — keep both)

**Process/superpowers (13):** brainstorming, dispatching-parallel-agents, executing-plans, finishing-a-development-branch, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, verification-before-completion, writing-plans, writing-skills (standard, keep)

### Executed consolidation (35 → 29)

| Action | Skills | Rationale |
|---|---|---|
| Merge | android-design-tokens + design-system-tokens → `design-tokens` | Same topic; second is generic Figma bridge. Keep one with both scopes. |
| Merge | compose-accessibility + android-accessibility-audit → `android-accessibility` | Audit vs build are two modes of one skill. |
| Merge | android-material3-design → fold into android-compose-ui-ux | M3 is the default in Compose UI skill; separate skill redundant. |
| Merge | motion-design → fold into android-compose-ui-ux | Motion is part of high-end Compose UI. |
| Merge | uiux-design-foundations → fold into android-compose-ui-ux | Foundations are covered. |
| Merge | android-adaptive-layouts → fold into android-compose-ui-ux | Adaptive is part of Compose UI. |
| Keep (distinct) | figma-to-compose, content-design-microcopy, design-critique, wcag-audit, usability-testing, ux-research-planning | Distinct jobs; low overlap. |
| Keep | all others | Distinct jobs. |

Net: remove ~7-9 skill directories, merge content into survivors. Reversible via git.

## 6. What was done

The consolidation plan above was **approved and executed** on the `dynamic-analysis`
branch. `skills/` now holds 29 skill directories (down from 35):

- The six merged clusters were folded into `design-tokens`, `android-accessibility`,
  and `android-compose-ui-ux`; the removed directories are gone.
- README counts/anchors and the skill listing were updated to 29.
- `scripts/register.sh` now also prunes global skill copies that no longer exist in
  `skills/` (only directories containing `SKILL.md`), so removed/renamed skills stop
  being discovered in `~/.config/opencode/skills/`.

The Appllama ruling in section 4 is unchanged: **no** Appllama skills or MCP were
added. The consolidation is reversible via git history (`c7ad43a`).

Optional follow-up (still deferred): mine general, stack-agnostic principles (motion
frequency gate, navigation one-way doors, anti-slop pre-flight, simulator loop) into
`android-compose-ui-ux` as a short appendix.
