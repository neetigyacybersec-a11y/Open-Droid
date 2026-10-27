#!/usr/bin/env bash
# Pre-populate the vendored Gradle cache with Android/AGP dependencies by
# building the starter template once while online. After this, offline builds
# (`gradle --offline`) resolve from the local cache.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.toolchain/env.sh" 2>/dev/null || true
export GRADLE_USER_HOME="$ROOT/.toolchain/gradle-home"
mkdir -p "$GRADLE_USER_HOME"
cd "$ROOT/templates/compose-starter"
echo "[warm-cache] Building starter template to populate Gradle cache (this may take a few minutes)..."
gradle --no-daemon :app:assembleDebug
echo "[warm-cache] Done. Offline builds should now resolve AGP and dependencies."
