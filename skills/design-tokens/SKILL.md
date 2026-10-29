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

## When to use me
- Setting up a new design system or theming a Compose app.
- Creating or extending a design system.

## Anti-patterns
- Hardcoded values; unversioned tokens; combinatorial variant explosion.
