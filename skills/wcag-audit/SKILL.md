---
name: wcag-audit
description: Audit UI against WCAG POUR principles and conformance levels (A/AA/AAA) with concrete test procedures
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Check Perceivable: text alternatives, captions, contrast (4.5:1 / 3:1).
- Check Operable: keyboard/switch access, focus, no seizure content.
- Check Understandable: readable, predictable, input assistance.
- Check Robust: semantic markup, assistive-tech compatibility.
- Target AA baseline; AAA for critical flows.

## When to use me
Use during accessibility review before release.

## Anti-patterns
- Contrast failures; missing focus indicators; color-only information.
