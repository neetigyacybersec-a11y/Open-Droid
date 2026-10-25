---
name: android-reverse-engineering
description: Reverse engineer Android APKs/AABs — decompile with JADX/apktool, inspect manifests, resources, smali, and compare versions using REA
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: android
  borrows: reverse-engineer-anything
---
## What I do
- Decompile APKs with JADX (Java/Kotlin) and apktool (resources/smali).
- Inspect AndroidManifest.xml, permissions, components, intents.
- Extract and analyze native libraries (.so) and assets.
- Compare app versions and reconstruct feature behavior.
- Leverage the REA MCP server (rea) for binary analysis, Ghidra/JADX/binwalk.

## Tools (via rea MCP + shell)
- `jadx` — decompile DEX to Java.
- `apktool` — decode resources and smali.
- `rea` MCP — Ghidra/JADX/binwalk/unblob for native code.
- `aapt2`/`bundletool` — inspect bundles.

## When to use me
- Analyzing a third-party or legacy APK.
- Investigating undocumented behavior or security issues.
- Comparing two builds of an app.

## Attribution
Borrows structure and methodology from the `reverse-engineer-anything` skill (rea-agents).
