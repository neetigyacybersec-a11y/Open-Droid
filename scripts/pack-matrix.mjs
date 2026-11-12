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

const packs = Object.entries(manifest.packs).map(([id, { artifacts }]) => {
  const rows = (artifacts ?? []).map((coordinate) => ({ coordinate, status: status(coordinate) }));
  return { id, resolved: rows.filter((r) => r.status === 'resolved').length, artifacts: rows };
});

if (process.argv.includes('--summary')) {
  for (const p of packs) {
    const missingArtifacts = p.artifacts.filter((r) => r.status === 'missing');
    const line = p.resolved === p.artifacts.length
      ? `OK   pack ${p.id}: ${p.resolved}/${p.artifacts.length} artifacts cached`
      : `MISS pack ${p.id}: ${p.resolved}/${p.artifacts.length} artifacts cached (${missingArtifacts.map((m) => m.coordinate.split(':')[1]).join(', ')})`;
    console.log(line);
  }
  process.exit(0);
}

console.log(JSON.stringify({
  cacheRoot: filesRoot,
  missing: packs.reduce((n, p) => n + p.artifacts.filter((r) => r.status === 'missing').length, 0),
  packs,
}, null, 2));
