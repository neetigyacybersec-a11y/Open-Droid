#!/usr/bin/env bash
# FR-R1 / ISSUE-17: resolve declared dependency packs from manifest/packs.json
# into the vendored Gradle cache while online, so pack consumers build offline.
# Usage: pack-warm.sh [pack ...]   (no args = every pack in the manifest)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/.toolchain/env.sh" 2>/dev/null || true
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.toolchain/gradle-home}"
mkdir -p "$GRADLE_USER_HOME"
if ! command -v gradle >/dev/null 2>&1; then
  echo "[pack-warm] ERROR: gradle not found — run 'make setup' first." >&2
  exit 1
fi
PACK_IDS=("$@")
if [ "${#PACK_IDS[@]}" -eq 0 ]; then
  # ISSUE-64: no args = every pack declared in the manifest (documented contract).
  mapfile -t PACK_IDS < <(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$ROOT/manifest/packs.json','utf8')).packs).join('\n'))")
fi
for id in "${PACK_IDS[@]}"; do
  node -e "const p=JSON.parse(require('fs').readFileSync('$ROOT/manifest/packs.json','utf8')).packs; process.exit(p['$id'] ? 0 : 1)" \
    || { echo "[pack-warm] ERROR: unknown pack '$id'" >&2; exit 1; }
done

WARM="$(mktemp -d)"
trap 'rm -rf "$WARM"' EXIT
node - "$WARM" "$ROOT" "${PACK_IDS[@]}" <<'EOF'
const fs = require('fs');
const path = require('path');
const [warm, root, ...ids] = process.argv.slice(2);
const packs = JSON.parse(fs.readFileSync(path.join(root, 'manifest', 'packs.json'), 'utf8')).packs;
const coords = [];
const pluginIds = [];
for (const id of ids) {
  const artifacts = packs[id].artifacts ?? [];
  for (const c of artifacts) {
    const [, , version] = c.split(':');
    if (!version) continue; // BOM-managed, handled by the platform() line below
    coords.push(`implementation("${c}")`);
  }
  if (artifacts.some((c) => c.split(':').length === 2)) {
    coords.unshift('implementation(platform("androidx.compose:compose-bom:2024.11.00"))');
  }
  for (const plugin of packs[id].plugins ?? []) pluginIds.push(plugin);
}
// ISSUE-17: libraries are not enough — a plugin marker (e.g. Hilt) is resolved
// separately and must also be in the offline cache. Hilt needs Kotlin + kapt
// applied before it.
const hasHilt = pluginIds.some((p) => p.startsWith('com.google.dagger.hilt.android:'));
const pluginLines = ['id("com.android.application") version "8.7.2"'];
if (hasHilt) {
  pluginLines.push('id("org.jetbrains.kotlin.android") version "2.0.21"');
  pluginLines.push('id("org.jetbrains.kotlin.kapt") version "2.0.21"');
}
for (const plugin of pluginIds) {
  const [pluginId, version] = plugin.split(':');
  if (!pluginId || !version) throw new Error(`plugin ${plugin} must be id:version`);
  pluginLines.push(`id("${pluginId}") version "${version}"`);
}
const pluginBlock = pluginLines.join('\n    ');
const depBlock = coords.length ? coords.join('\n') : '// nothing in this pack';
fs.writeFileSync(path.join(warm, 'settings.gradle.kts'), `pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "pack-warm"
`);
fs.writeFileSync(path.join(warm, 'gradle.properties'), 'android.useAndroidX=true\nkapt.use.k2=true\n');
fs.writeFileSync(path.join(warm, 'build.gradle.kts'), `plugins {
    ${pluginBlock}
}
android {
    namespace = "warm.pack"
    compileSdk = 35
}
dependencies {
${depBlock}
}
tasks.register("resolvePack") {
    doLast {
        val resolved = configurations.getByName("debugRuntimeClasspath").resolve()
        println("RESOLVED \${resolved.size} artifacts")
    }
}
`);
EOF

echo "[pack-warm] Resolving: ${PACK_IDS[*]}"
(cd "$WARM" && gradle --no-daemon resolvePack)
echo "[pack-warm] Proving offline resolution for the same packs..."
(cd "$WARM" && gradle --no-daemon resolvePack --offline) || {
  echo "[pack-warm] ERROR: resolved pack does not resolve offline — cache incomplete." >&2
  exit 1
}
node "$ROOT/scripts/pack-matrix.mjs" | grep -E "^\s+\"(id|resolved)\"" | tr -d ' ",\n' | paste -sd' '
echo "[pack-warm] Done."
