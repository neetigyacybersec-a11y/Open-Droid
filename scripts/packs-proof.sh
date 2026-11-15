#!/usr/bin/env bash
# FR-R1 / ISSUE-17: cache presence proves nothing on its own. Build a fresh copy
# of the reference consumer with --offline and fail if any pack does not resolve.
# The reference project uses every pack in manifest/packs.json.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.toolchain/env.sh" 2>/dev/null || true
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.toolchain/gradle-home}"
mkdir -p "$ROOT/.toolchain" "$GRADLE_USER_HOME"
PROOF="$ROOT/.toolchain/packs-proof"
rm -rf "$PROOF"
cp -r "$ROOT/examples/packs-reference" "$PROOF"
# A copied build directory would mask a cold resolve with stale outputs.
find "$PROOF" -type d \( -name build -o -name .gradle \) -prune -exec rm -rf {} +

echo "[packs-proof] Building a fresh reference copy with --offline..."
if gradle --no-daemon -p "$PROOF" \
  :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest --offline; then
  echo "[packs-proof] Passed: every pack resolves offline (build, unit tests, instrumented test compile)."
  rm -rf "$PROOF"
else
  echo "[packs-proof] FAILED: the reference project does not resolve offline." >&2
  echo "[packs-proof] Run scripts/pack-warm.sh (or scripts/warm-cache.sh) online, then re-run this check." >&2
  rm -rf "$PROOF"
  exit 1
fi
