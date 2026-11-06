// FR-R1 / ISSUE-17: dependency packs. The declared packs must exist as a checked-in
// manifest, scripts/pack-matrix.mjs must report resolved/missing per artifact from
// the vendored Gradle cache, and doctor must surface the matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(REPO, 'manifest/packs.json'), 'utf8'));

test('pack manifest declares compose/app/data/net/di/test with pinned artifacts', () => {
  for (const id of ['compose', 'app', 'data', 'net', 'di', 'test']) {
    assert.ok(manifest.packs[id], `pack ${id} missing from manifest`);
  }
  for (const id of ['app', 'data', 'net', 'di', 'test']) {
    assert.ok(manifest.packs[id].artifacts.length > 0, `pack ${id} has no artifacts`);
    for (const c of manifest.packs[id].artifacts) {
      const parts = c.split(':');
      assert.ok(
        parts.length === 2 || parts.length === 3,
        `artifact ${c} must be group:artifact[:version] (2 segments = BOM-managed)`,
      );
    }
  }
});

test('pack-matrix reports resolved/missing per artifact from the cache', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'packmatrix-'));
  // seed the cache with two artifacts of the "app" pack
  const appPacks = manifest.packs.app.artifacts.slice(0, 2);
  for (const c of appPacks) {
    const [group, artifact] = c.split(':');
    mkdirSync(path.join(tmp, 'caches/modules-2/files-2.1', group, artifact), { recursive: true });
  }
  try {
    const out = JSON.parse(
      execFileSync('node', ['scripts/pack-matrix.mjs'], {
        cwd: REPO,
        env: { ...process.env, GRADLE_USER_HOME: tmp },
        encoding: 'utf8',
      }),
    );
    assert.equal(out.cacheRoot, path.join(tmp, 'caches/modules-2/files-2.1'));
    const appPack = out.packs.find((p) => p.id === 'app');
    for (const a of appPack.artifacts) {
      assert.ok(
        appPacks.includes(a.coordinate)
          ? a.status === 'resolved'
          : a.status === 'missing',
        `${a.coordinate} misreported as ${a.status}`,
      );
    }
    assert.ok(out.missing >= appPack.artifacts.filter((a) => a.status === 'missing').length);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('doctor surfaces the pack matrix when the cache exists', () => {
  const doctor = readFileSync(path.join(REPO, 'scripts/doctor.sh'), 'utf8');
  assert.ok(doctor.includes('scripts/pack-matrix.mjs'), 'doctor must call pack-matrix.mjs');
  const cacheCheck = doctor.indexOf('gradle-home/caches/modules-2/files-2.1');
  const matrixCall = doctor.indexOf('scripts/pack-matrix.mjs');
  assert.ok(cacheCheck >= 0 && cacheCheck < matrixCall, 'matrix must run only when the cache exists');
});
