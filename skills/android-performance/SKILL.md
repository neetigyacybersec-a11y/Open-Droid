---
name: android-performance
description: Improve app performance with baseline profiles, macrobenchmarks, recomposition counts, and image loading
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: compose
---
## What I do
- Add Baseline Profiles and Macrobenchmark.
- Measure recomposition and jank.
- Optimize image loading and startup.

## Motion performance (route)
- Motion jank is a performance defect: animate cheap properties only (`translationX/Y/Z`,
  `scaleX/Y`, `alpha`, `rotation`, or state inside `graphicsLayer {}`); never layout size or
  position per frame. Reduced-motion, springs and jank rules:
  android-compose-ui-ux -> `references/motion/performance-and-accessibility.md`.

## When to use me
- Performance regressions or startup optimization.
