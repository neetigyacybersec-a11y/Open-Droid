---
name: android-compose-ui-ux
description: Build high-end Jetpack Compose UI with Material 3, motion, accessibility, adaptive layouts, design tokens, and foundations
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: compose
---
## What I do
- Guide Compose + Material 3 implementation for premium UI.
- Cover typography, color roles, motion, haptics, edge-to-edge, adaptive layouts, large screens.
- Enforce recomposition hygiene, LazyColumn keys/contentType, animation APIs.

## Consolidated capabilities (merged from android-material3-design, motion-design, uiux-design-foundations, android-adaptive-layouts)

### Material 3 tokens
- Map M3 color roles to MaterialTheme.colorScheme.* (never hardcode hex for text/surfaces).
- Use the M3 type scale tokens (display/headline/title/body/label x S/M/L + emphasized).
- Apply 8dp spacing grid and shape tokens (none/XS/S/M/L/XL/full).
- Verify dark + light themes and dynamic color fallback.
- Check contrast >= 4.5:1 (normal) / >= 3:1 (large) text.
- Anti-patterns: hardcoded colors/sizes; M2 components; ignoring dynamic color; text in dp instead of sp.

### Motion
- Use M3 motion schemes (standard/expressive) and spring tokens.
- Apply transitions: container transform, shared axis, fade through, fade.
- Keep durations 100-500ms; respect reduced motion.
- Ensure motion is functional (orient, confirm, connect).
- Anti-patterns: decorative-only motion; arbitrary easing; blocking input; ignoring accessibility.

### Foundations
- Establish type scale, color roles, spacing grid (8dp), shape tokens, elevation, iconography.
- Enforce contrast (>=4.5:1 normal, >=3:1 large), line length 45-75 chars, line height 1.4-1.6.
- Guide motion: functional, 100-500ms, respect reduced motion.
- Anti-patterns: hardcoded colors/sizes; ignoring dark mode; text in dp; decorative-only motion.

### Adaptive layouts
- Use WindowSizeClass (compact/medium/expanded) for responsive layouts.
- Apply canonical layouts: list-detail, supporting pane, feed.
- Use NavigationSuiteScaffold to switch bottom nav / rail / drawer.
- Handle foldables (tabletop/book posture, hinge), multi-window, freeform.
- Support mouse/trackpad/keyboard/stylus with hover and focus.
- Anti-patterns: fixed widths; assuming full-screen; ignoring orientation; content across hinges.

## When to use me
- Building or refactoring Compose screens.
- Reviewing UI quality, performance, or accessibility.
- Adaptive, motion, or M3 token work (consolidated here).
