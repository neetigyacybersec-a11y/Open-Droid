#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-my-app}"
if [ -e "$APP" ]; then echo "ERROR: $APP already exists"; exit 1; fi
# FR-B1 / ISSUE-13: without sdk.dir the first build dies with "SDK location not found".
# Fail with a clear reason before doing any work if ANDROID_HOME is unavailable.
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: ANDROID_HOME is unset; source .toolchain/env.sh before scaffolding $APP" >&2
  exit 1
fi

# Copy source only. Generated Gradle output is stale, package-specific and
# tens of megabytes; it must never reach a new project (FR-R20 / ISSUE-38).
TEMPLATE="$ROOT/templates/compose-starter"
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='build/' \
    --exclude='.gradle/' \
    --exclude='local.properties' \
    --exclude='.idea/' \
    "$TEMPLATE/" "$APP/"
else
  cp -r "$TEMPLATE" "$APP"
  rm -rf "$APP/.gradle" "$APP/.idea" "$APP/local.properties"
  find "$APP" -type d -name build -prune -exec rm -rf {} +
fi
echo "sdk.dir=$ANDROID_HOME" > "$APP/local.properties"
# rename package
PKG="com.example.$(echo "$APP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
sed -i "s/com\.example\.starter/$PKG/g" "$APP"/app/build.gradle.kts "$APP"/app/src/main/AndroidManifest.xml $(find "$APP" -name "*.kt")
echo "Scaffolded $APP with package $PKG"
echo "Next: source .toolchain/env.sh && cd $APP && gradle :app:assembleDebug"
