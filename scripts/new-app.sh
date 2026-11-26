#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-my-app}"
PKG_ARG="${2:-}"
case "$APP" in
  -*) echo "ERROR: app name must not start with '-': $APP" >&2; exit 1 ;;
esac
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
# Stage in a sibling directory and publish with one rename, so a failed
# substitution leaves no half-scaffolded destination (ISSUE-185).
TEMPLATE="$ROOT/templates/compose-starter"
STAGE="$(mktemp -d "$(dirname "$APP")/.${APP_BASENAME}.stage.XXXXXX")"
cleanup() {
  if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
}
trap cleanup EXIT
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='build/' \
    --exclude='.gradle/' \
    --exclude='local.properties' \
    --exclude='.idea/' \
    "$TEMPLATE/" "$STAGE/"
else
  cp -r "$TEMPLATE/." "$STAGE/"
  rm -rf "$STAGE/.gradle" "$STAGE/.idea" "$STAGE/local.properties"
  find "$STAGE" -type d -name build -prune -exec rm -rf {} +
fi
echo "sdk.dir=$ANDROID_HOME" > "$STAGE/local.properties"
# Node-based replacement: portable across GNU and BSD sed (ISSUE-185).
node - "$STAGE" "$PKG" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, pkg] = process.argv.slice(2);
const EXTENSIONS = new Set([".kt", ".kts", ".gradle", ".xml"]);
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      const before = fs.readFileSync(file, "utf8");
      const after = before.replaceAll("com.example.starter", pkg);
      if (after !== before) fs.writeFileSync(file, after);
    }
  }
};
walk(root);
NODE
mv "$STAGE" "$APP"
trap - EXIT
echo "Scaffolded $APP with package $PKG"
echo "Next: source .toolchain/env.sh && cd $APP && gradle :app:assembleDebug"
