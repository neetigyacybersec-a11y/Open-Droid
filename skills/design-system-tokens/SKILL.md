---
name: design-system-tokens
description: Build and maintain design tokens (color, type, shape, spacing) bridging Figma variables and Compose themes
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Structure M3 token pipeline: reference -> system -> component tokens.
- Map Figma variables (color/number/string/boolean) with modes (light/dark) to Compose.
- Theme variants, dark mode, dynamic color, component variants.
- Document token naming and ownership.

## When to use me
Use when creating or extending a design system.

## Anti-patterns
- Hardcoded values; unversioned tokens; combinatorial variant explosion.
