---
name: design-critique
description: Review designs against hierarchy, affordance, states, consistency, and accessibility checklists. Use when reviewing, improving, or polishing an existing screen or app, including before visual QA completion.
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Check visual hierarchy, affordances, all component states.
- Verify consistency with design system and tokens.
- Audit accessibility (contrast, touch targets, semantics).
- Give actionable, specific feedback.
- Motion is part of the critique: run the motion review checklist
  (android-compose-ui-ux -> `references/motion/review-checklist.md`) — durations, one hero,
  interruption safety, reduced motion, RTL, dark mode — before calling motion done.
- Audio is reviewed only when the feature includes sound or the brief calls for it: check semantic intent, mute behavior, equivalent visual feedback and provenance via android-compose-ui-ux -> `references/sound/sound-review-checklist.md`.
- Haptic behavior is inspected when present: single cue on the committed state change, absent on scrolling/recomposition, settings honored. Motion, sound and haptics are reviewed as separate evidence, never substituted for one another (android-compose-ui-ux -> `references/interaction-evidence/verification-discipline.md`).

## When to use me
Use during PR/design review.

## Anti-patterns
- Vague feedback; reviewing only happy path; skipping accessibility.
