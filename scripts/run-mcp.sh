#!/usr/bin/env bash
# Portable launcher for the android-mcp server (used by OpenCode project config).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.toolchain/env.sh" ]; then source "$ROOT/.toolchain/env.sh"; fi
cd "$ROOT"

# Resolve node even when the spawning app's environment has a minimal PATH
# (daemon contexts, GUI launchers, restricted shells). Fall back to the
# common install locations across Linux/macOS/Git Bash on Windows.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for c in node node.exe; do
    for p in /usr/local/bin /usr/bin "$HOME/bin"; do
      if [ -x "$p/$c" ]; then NODE_BIN="$p/$c"; break 2; fi
    done
    # nvm-managed node (last installed version)
    NBIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
    if [ -n "$NBIN" ] && [ -x "${NBIN}/$c" ]; then NODE_BIN="${NBIN}/$c"; break; fi
    # Windows (Node installed via winget/installer), seen from Git Bash/MSYS
    if [ -n "$PROGRAMFILES" ] && [ -x "$PROGRAMFILES/nodejs/$c" ]; then
      NODE_BIN="$PROGRAMFILES/nodejs/$c"; break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH or in common install locations; install Node >= 20 (https://nodejs.org)" >&2
  exit 1
fi

exec "$NODE_BIN" "$ROOT/dist/index.js"
