---
name: compose-accessibility
description: Make Jetpack Compose UI accessible: semantics, content descriptions, touch targets, focus, TalkBack, reduced motion
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Add contentDescription, role, stateDescription, heading() to semantics.
- Ensure touch targets >= 48dp; use minimumInteractiveComponentSize().
- Support TalkBack, switch access, large text, RTL.
- Respect reduced motion and font scaling up to 200%.

## When to use me
Use when implementing or reviewing any composable.

## Anti-patterns
- Images without contentDescription; small touch targets; ignoring focus order.
