---
name: design-critique
description: Review designs against hierarchy, affordance, states, consistency, and accessibility checklists
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

## When to use me
Use during PR/design review.

## Anti-patterns
- Vague feedback; reviewing only happy path; skipping accessibility.
