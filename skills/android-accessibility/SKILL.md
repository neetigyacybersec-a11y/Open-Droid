---
name: android-accessibility
description: Make and audit Jetpack Compose UI accessibility: semantics, content descriptions, touch targets, focus, TalkBack, reduced motion, contrast, font scaling. Use for new or changed UI and review gates, not only explicit accessibility requests.
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do (build)
- Add contentDescription, role, stateDescription, heading() to semantics.
- Ensure touch targets >= 48dp; use minimumInteractiveComponentSize().
- Support TalkBack, switch access, large text, RTL.
- Respect reduced motion and font scaling up to 200%.
- When a feature includes sound, verify mute/preference, silent/DND behavior and equivalent visual/semantic feedback via android-compose-ui-ux -> `references/sound/sound-accessibility-and-settings.md`; audio is never the only carrier.
- Verify non-audio feedback and user controls for haptics too: one cue per committed state change, none on scrolling or recomposition, system haptic settings honored. See android-compose-ui-ux -> `references/interaction-evidence/deterministic-scenarios.md` for the reduced-motion and feedback on/off passes.
- Reduced-motion wiring is a build requirement, not a review finding: Views honor
  `ANIMATOR_DURATION_SCALE == 0` automatically, Compose does not — wire the helper from
  android-compose-ui-ux -> `references/motion/MotionTokens.kt` and the rules in
  `references/motion/performance-and-accessibility.md`.

## What I audit
- Check semantic roles, contentDescription, headings.
- Verify touch targets >= 48dp and contrast ratios.
- Test font scaling up to 200% and reduced motion.

## When to use me
- Implementing or reviewing any composable.
- Reviewing UI accessibility before release.

## Anti-patterns
- Images without contentDescription; small touch targets; ignoring focus order.
