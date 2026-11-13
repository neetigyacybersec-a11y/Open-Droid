#!/usr/bin/env bash
# Pre-populate the vendored Gradle cache with Android/AGP dependencies by
# building the starter template once while online. After this, offline builds
# (`gradle --offline`) resolve from the local cache.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.toolchain/env.sh" 2>/dev/null || true
if ! command -v gradle >/dev/null 2>&1; then
  echo "[warm-cache] ERROR: gradle not found — run 'make setup' first (vendors the toolchain)." >&2
  exit 1
fi
export GRADLE_USER_HOME="$ROOT/.toolchain/gradle-home"
mkdir -p "$GRADLE_USER_HOME"
cd "$ROOT/templates/compose-starter"
echo "[warm-cache] Building starter template to populate Gradle cache (this may take a few minutes)..."
gradle --no-daemon :app:assembleDebug
# FR-B2: androidTest needs its own runtime classpath (espresso-jsr305 etc.); warm it
# so the instrumented-test compile resolves offline too.
gradle --no-daemon :app:assembleDebugAndroidTest
# ---- Offline proof (ISSUE-14 / FR-D2): the warm build above proves nothing about
# a fresh project resolving --offline; run the shared proof build.
bash "$ROOT/scripts/offline-proof.sh"
# PACKS (FR-R1): comma/space separated pack ids resolve pack artifacts online.
# Empty = template-only warm (the compose pack is covered by the build above).
PACKS="${PACKS:-}"
PACKS="${PACKS//,/ }"
if [ -n "$PACKS" ]; then
  for p in $PACKS; do
    bash "$ROOT/scripts/pack-warm.sh" "$p" || exit 1
  done
fi
echo "[warm-cache] Done. Offline builds should now resolve AGP and dependencies."
