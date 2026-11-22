---
name: figma-to-compose
description: Convert Figma designs to Jetpack Compose using Figma MCP output, mapping variables to tokens and components to composables. Use when a Figma design is available or the user asks to translate Figma to Compose.
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Fetch design context, variables, screenshots via Figma MCP.
- Map Figma variables to Compose color/spacing tokens.
- Map auto-layout to Row/Column/Modifiers.
- Map components to composables; set up Code Connect.

## When to use me
Use for design-to-code handoff.

## Anti-patterns
- Pixel-perfect hardcoding; ignoring tokens; skipping responsive behavior.
