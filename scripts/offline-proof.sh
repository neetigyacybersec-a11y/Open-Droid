#!/usr/bin/env bash
# FR-D2 / ISSUE-14: a cache directory or one warm build proves nothing. Run gradle
# --offline against a fresh copy of the template and fail loudly if it does not
# resolve. Shared by warm-cache.sh (after warming) and doctor.sh (as a hard check).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.toolchain/env.sh" 2>/dev/null || true
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.toolchain/gradle-home}"
mkdir -p "$ROOT/.toolchain" "$GRADLE_USER_HOME"
PROOF="$ROOT/.toolchain/offline-proof"
rm -rf "$PROOF"
cp -r "$ROOT/templates/compose-starter" "$PROOF"
echo "[offline-proof] Building a fresh template copy with --offline..."
if gradle --no-daemon -p "$PROOF" :app:assembleDebug --offline; then
  # FR-B2: the template ships JVM Compose tests; prove their target runs offline too.
  if gradle --no-daemon -p "$PROOF" :app:testDebugUnitTest --offline; then
    echo "[offline-proof] Passed: a fresh project resolves everything from cache (build + unit tests)."
    rm -rf "$PROOF"
  else
    echo "[offline-proof] FAILED: testDebugUnitTest does not resolve offline." >&2
    echo "[offline-proof] Run scripts/warm-cache.sh fully online, then re-run this check." >&2
    rm -rf "$PROOF"
    exit 1
  fi
else
  echo "[offline-proof] FAILED: the cache did not resolve a fresh offline build." >&2
  echo "[offline-proof] Run scripts/warm-cache.sh fully online, then re-run this check." >&2
  rm -rf "$PROOF"
  exit 1
fi
