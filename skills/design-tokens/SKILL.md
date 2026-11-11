---
name: design-tokens
description: Define and maintain design tokens (color, type, shape, spacing) as the single source of truth for Compose themes, bridging Figma variables
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: compose
---
## What I do
- Structure Color.kt, Type.kt, Shape.kt, Spacing.kt.
- Map Figma variables to Compose ColorScheme/Typography.
- Support light/dark and dynamic color (Material You).
- Structure M3 token pipeline: reference -> system -> component tokens.
- Map Figma variables (color/number/string/boolean) with modes (light/dark) to Compose.
- Theme variants, dark mode, dynamic color, component variants.
- Document token naming and ownership.
- Motion tokens follow the same discipline: durations, M3 easings and spring presets live in a
  single `MotionTokens` object, never hardcoded inline. Template and rules:
  android-compose-ui-ux -> `references/motion/MotionTokens.kt` + `references/motion/timing-and-easing.md`.

## When to use me
- Setting up a new design system or theming a Compose app.
- Creating or extending a design system.

## Anti-patterns
- Hardcoded values; unversioned tokens; combinatorial variant explosion.
