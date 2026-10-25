#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"
fail=0
check(){ if command -v "$1" >/dev/null 2>&1; then echo "OK   $1 -> $(command -v "$1")"; else echo "MISS $1"; fail=1; fi; }
echo "== android-mcp doctor =="
if [ -f "$TOOLCHAIN/env.sh" ]; then source "$TOOLCHAIN/env.sh"; echo "toolchain env: loaded"; else echo "toolchain env: NOT FOUND (run 'make setup')"; fi
for c in node java javac gradle adb emulator sdkmanager avdmanager maestro; do check "$c"; done
echo "ANDROID_HOME=${ANDROID_HOME:-unset}"
echo "JAVA_HOME=${JAVA_HOME:-unset}"
echo "node=$(node -v 2>/dev/null)  npm=$(npm -v 2>/dev/null)"
[ -f "$ROOT/dist/index.js" ] && echo "MCP build: present" || { echo "MCP build: MISSING (run npm run build)"; fail=1; }
[ -d "$TOOLCHAIN/android-skills/.git" ] && echo "android/skills: cloned" || echo "android/skills: not cloned (optional)"
exit $fail
