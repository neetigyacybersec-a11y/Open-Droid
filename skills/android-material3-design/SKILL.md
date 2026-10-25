---
name: android-material3-design
description: Apply Material 3 design tokens, color roles, typography, shapes, and elevation when building or reviewing Jetpack Compose UI for Android
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Map M3 color roles to MaterialTheme.colorScheme.* (never hardcode hex for text/surfaces).
- Use the M3 type scale tokens (display/headline/title/body/label x S/M/L + emphasized).
- Apply 8dp spacing grid and shape tokens (none/XS/S/M/L/XL/full).
- Verify dark + light themes and dynamic color fallback.
- Check contrast >= 4.5:1 (normal) / >= 3:1 (large) text.

## When to use me
Use when implementing or reviewing any Compose screen, component, or theme.

## Anti-patterns
- Hardcoded colors/sizes; M2 components; ignoring dynamic color; text in dp instead of sp.
