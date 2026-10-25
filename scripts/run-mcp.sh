#!/usr/bin/env bash
# Portable launcher for the android-mcp server (used by OpenCode project config).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.toolchain/env.sh" ]; then source "$ROOT/.toolchain/env.sh"; fi
cd "$ROOT"
exec node "$ROOT/dist/index.js"
