#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-my-app}"
PKG_ARG="${2:-}"
if [ -e "$APP" ]; then echo "ERROR: $APP already exists"; exit 1; fi
# FR-B1 / ISSUE-13: without sdk.dir the first build dies with "SDK location not found".
# Fail with a clear reason before doing any work if ANDROID_HOME is unavailable.
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: ANDROID_HOME is unset; source .toolchain/env.sh before scaffolding $APP" >&2
  exit 1
fi

# Package name derives from the project directory basename (not the full path)
# and is validated before anything is copied, so an invalid name never leaves a
# partial project behind (issue 89). An explicit full package may be passed as
# the second argument.
APP_BASENAME="$(basename "$APP")"
if [ -n "$PKG_ARG" ]; then
  PKG="$PKG_ARG"
else
  SLUG="$(printf '%s' "$APP_BASENAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  if ! printf '%s' "$SLUG" | grep -Eq '^[a-z][a-z0-9]*$'; then
    echo "ERROR: cannot derive a valid package name from '$APP_BASENAME'; pass one as the second argument, e.g. com.example.myapp" >&2
    exit 1
  fi
  PKG="com.example.$SLUG"
fi
if ! printf '%s' "$PKG" | grep -Eq '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'; then
  echo "ERROR: invalid package name '$PKG'; use lowercase dot-separated segments, e.g. com.example.myapp" >&2
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
# rename package (null-safe traversal: paths may contain spaces)
sed -i "s/com\.example\.starter/$PKG/g" "$APP/app/build.gradle.kts" "$APP/app/src/main/AndroidManifest.xml"
find "$APP" -name "*.kt" -exec sed -i "s/com\.example\.starter/$PKG/g" {} +
echo "Scaffolded $APP with package $PKG"
echo "Next: source .toolchain/env.sh && cd $APP && gradle :app:assembleDebug"
