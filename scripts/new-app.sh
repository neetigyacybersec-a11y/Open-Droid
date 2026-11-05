#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-my-app}"
if [ -e "$APP" ]; then echo "ERROR: $APP already exists"; exit 1; fi

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
# rename package
PKG="com.example.$(echo "$APP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
sed -i "s/com\.example\.starter/$PKG/g" "$APP"/app/build.gradle.kts "$APP"/app/src/main/AndroidManifest.xml $(find "$APP" -name "*.kt")
echo "Scaffolded $APP with package $PKG"
echo "Next: source .toolchain/env.sh && cd $APP && gradle :app:assembleDebug"
