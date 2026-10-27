#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-my-app}"
if [ -e "$APP" ]; then echo "ERROR: $APP already exists"; exit 1; fi
cp -r "$ROOT/templates/compose-starter" "$APP"
# rename package
PKG="com.example.$(echo "$APP" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
sed -i "s/com\.example\.starter/$PKG/g" "$APP"/app/build.gradle.kts "$APP"/app/src/main/AndroidManifest.xml $(find "$APP" -name "*.kt")
echo "Scaffolded $APP with package $PKG"
echo "Next: source .toolchain/env.sh && cd $APP && gradle :app:assembleDebug"
