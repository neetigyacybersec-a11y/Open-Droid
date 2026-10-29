---
name: android-accessibility
description: Make and audit Jetpack Compose UI accessibility: semantics, content descriptions, touch targets, focus, TalkBack, reduced motion, contrast, font scaling
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

## What I audit
- Check semantic roles, contentDescription, headings.
- Verify touch targets >= 48dp and contrast ratios.
- Test font scaling up to 200% and reduced motion.

## When to use me
- Implementing or reviewing any composable.
- Reviewing UI accessibility before release.

## Anti-patterns
- Images without contentDescription; small touch targets; ignoring focus order.
