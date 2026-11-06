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
# ---- Offline proof (ISSUE-14 / FR-D2): the warm build above proves nothing about
# a fresh project resolving --offline. Build a fresh copy of the template with
# networking disabled; fail loudly if the cache is missing artifacts (plugin markers).
OFFLINE_TMP="$ROOT/.toolchain/offline-proof"
rm -rf "$OFFLINE_TMP"
cp -r "$ROOT/templates/compose-starter" "$OFFLINE_TMP"
echo "[warm-cache] Proving the offline promise on a fresh template copy..."
if gradle --no-daemon -p "$OFFLINE_TMP" :app:assembleDebug --offline; then
  echo "[warm-cache] Offline proof passed: a fresh project resolves everything from cache."
else
  echo "[warm-cache] ERROR: offline build of a fresh project failed — cache is incomplete." >&2
  echo "[warm-cache] Ensure gradle ran online above (SDK, JAVA_HOME set), then re-run warm-cache." >&2
  rm -rf "$OFFLINE_TMP"
  exit 1
fi
rm -rf "$OFFLINE_TMP"
echo "[warm-cache] Done. Offline builds should now resolve AGP and dependencies."
