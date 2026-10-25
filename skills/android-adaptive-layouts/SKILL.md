---
name: android-adaptive-layouts
description: Build adaptive Android UIs with WindowSizeClass, canonical layouts, foldables, large screens, and multi-input support
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Use WindowSizeClass (compact/medium/expanded) for responsive layouts.
- Apply canonical layouts: list-detail, supporting pane, feed.
- Use NavigationSuiteScaffold to switch bottom nav / rail / drawer.
- Handle foldables (tabletop/book posture, hinge), multi-window, freeform.
- Support mouse/trackpad/keyboard/stylus with hover and focus.

## When to use me
Use when a screen must adapt across phone, tablet, foldable, or desktop.

## Anti-patterns
- Fixed widths; assuming full-screen; ignoring orientation; content across hinges.
