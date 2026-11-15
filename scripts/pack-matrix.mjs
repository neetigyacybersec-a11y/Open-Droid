#!/usr/bin/env node
// FR-R1 / ISSUE-17 dependency-pack coverage: read manifest/packs.json and report
// per artifact whether the vendored Gradle cache (GRADLE_USER_HOME, default
// .toolchain/gradle-home) already holds the group/artifact. Print doctor-style
// OK/MISS lines. Informational: whether a pack resolves is proven by build, not
// by cache presence.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const gradleHome = process.env.GRADLE_USER_HOME || path.join(REPO, '.toolchain/gradle-home');
const filesRoot = path.join(gradleHome, 'caches', 'modules-2', 'files-2.1');
const manifest = JSON.parse(readFileSync(path.join(REPO, 'manifest/packs.json'), 'utf8'));

const status = (coordinate) => {
  const [group, artifact, version] = coordinate.split(':');
  // ISSUE-63: when the coordinate pins a version, only that version's
  // directory counts (modules-2/files-2.1/<group>/<artifact>/<version>/...).
  // Version-less (BOM-managed) coordinates keep the group/artifact check.
  if (version) {
    return existsSync(path.join(filesRoot, group, artifact, version)) ? 'resolved' : 'missing';
  }
  return existsSync(path.join(filesRoot, group, artifact)) ? 'resolved' : 'missing';
};

const pluginStatus = (plugin) => {
  // ISSUE-17: plugin markers live at <plugin-id>/<plugin-id>.gradle.plugin/<version>,
  // not under the library coordinate, so they need their own lookup.
  const [id, version] = plugin.split(':');
  if (!id || !version) return 'missing';
  return existsSync(path.join(filesRoot, id, `${id}.gradle.plugin`, version))
    ? 'resolved'
    : 'missing';
};

const packs = Object.entries(manifest.packs).map(([id, { artifacts = [], plugins = [] }]) => {
  const rows = artifacts.map((coordinate) => ({ coordinate, status: status(coordinate) }));
  const pluginRows = plugins.map((coordinate) => ({ coordinate, status: pluginStatus(coordinate) }));
  const all = [...rows, ...pluginRows];
  return {
    id,
    resolved: all.filter((r) => r.status === 'resolved').length,
    artifacts: rows,
    plugins: pluginRows,
  };
});

if (process.argv.includes('--summary')) {
  for (const p of packs) {
    const all = [...p.artifacts, ...p.plugins];
    const missingArtifacts = all.filter((r) => r.status === 'missing');
    const line = missingArtifacts.length === 0
      ? `OK   pack ${p.id}: ${p.resolved}/${all.length} artifacts cached`
      : `MISS pack ${p.id}: ${p.resolved}/${all.length} artifacts cached (${missingArtifacts.map((m) => m.coordinate.split(':')[1]).join(', ')})`;
    console.log(line);
  }
  process.exit(0);
}

console.log(JSON.stringify({
  cacheRoot: filesRoot,
  missing: packs.reduce((n, p) => n + [...p.artifacts, ...p.plugins].filter((r) => r.status === 'missing').length, 0),
  packs,
}, null, 2));
