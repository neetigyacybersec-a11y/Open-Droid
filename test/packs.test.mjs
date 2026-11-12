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
  // seed the cache with two artifacts of the "app" pack (ISSUE #63: the
  // seeded coordinates are version-pinned, so the seed must include the
  // version directory the matrix now requires)
  const appPacks = manifest.packs.app.artifacts.slice(0, 2);
  for (const c of appPacks) {
    const [group, artifact, version] = c.split(":");
    const dir = version ? path.join(group, artifact, version) : path.join(group, artifact);
    mkdirSync(path.join(tmp, "caches/modules-2/files-2.1", dir), { recursive: true });
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
  assert.ok(
    /pack-matrix\.mjs"?\s+--summary/.test(doctor),
    'doctor must print the pack matrix, not swallow it',
  );
  const cacheCheck = doctor.indexOf('gradle-home/caches/modules-2/files-2.1');
  const matrixCall = doctor.indexOf('scripts/pack-matrix.mjs');
  assert.ok(cacheCheck >= 0 && cacheCheck < matrixCall, 'matrix must run only when the cache exists');
});

test('pack-warm.sh resolves the declared packs into the cache', () => {
  const script = readFileSync(path.join(REPO, 'scripts/pack-warm.sh'), 'utf8');
  assert.ok(script.includes('manifest/packs.json'), 'must read the pack manifest, not a private list');
  assert.ok(script.includes('google()') && script.includes('mavenCentral()'), 'must resolve from google+mavenCentral');
  assert.ok(script.includes('resolvePack'), 'must run a Gradle resolution task');
  assert.ok(/pack-matrix\.mjs/.test(script), 'must report coverage with pack-matrix.mjs afterwards');
  assert.ok(/resolvePack.*--offline|--offline.*resolvePack/s.test(script), 'must prove the pack resolves offline after warming (FR-R1 acceptance)');
});

test('pack-warm.sh with no args warms every pack in the manifest (ISSUE #64)', () => {
  const script = readFileSync(path.join(REPO, 'scripts/pack-warm.sh'), 'utf8');
  assert.ok(
    !script.includes("no packs given"),
    "no-args must follow the documented contract (no args = every pack in the manifest), not error out",
  );
  // The empty-args branch must populate PACK_IDS from the manifest itself,
  // not from a hardcoded list or an error exit.
  const emptyArgsBranch = script.slice(script.indexOf('PACK_IDS='));
  assert.match(
    emptyArgsBranch,
    /-eq 0 \]; then[\s\S]*?manifest\/packs\.json/,
    "the no-args branch must enumerate every declared pack id from manifest/packs.json",
  );
  assert.match(
    emptyArgsBranch,
    /mapfile -t PACK_IDS < <\(node -e/,
    "no-args must populate PACK_IDS from the manifest enumeration",
  );
  for (const id of Object.keys(manifest.packs)) {
    assert.ok(
      emptyArgsBranch.includes('manifest/packs.json'),
      `no-args enumeration must cover pack '${id}' via the manifest`,
    );
  }
});

test("pack-matrix requires the pinned version dir in the cache (ISSUE #63)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "packmatrixver-"));
  const pinned = manifest.packs.app.artifacts.find((c) => c.split(":").length === 3);
  const [group, artifact, version] = pinned.split(":");
  const files = path.join(tmp, "caches/modules-2/files-2.1");
  // seed ONLY a different version of the same group/artifact
  mkdirSync(path.join(files, group, artifact, "0.0.0-NOT-PINNED"), { recursive: true });
  try {
    const missingOut = JSON.parse(
      execFileSync("node", ["scripts/pack-matrix.mjs"], {
        cwd: REPO,
        env: { ...process.env, GRADLE_USER_HOME: tmp },
        encoding: "utf8",
      }),
    );
    const missingRow = missingOut.packs
      .find((p) => p.id === "app")
      .artifacts.find((a) => a.coordinate === pinned);
    assert.equal(
      missingRow.status,
      "missing",
      "a different version of the same artifact must NOT count as resolved",
    );

    // seeding the pinned version dir flips it to resolved
    mkdirSync(path.join(files, group, artifact, version), { recursive: true });
    const resolvedOut = JSON.parse(
      execFileSync("node", ["scripts/pack-matrix.mjs"], {
        cwd: REPO,
        env: { ...process.env, GRADLE_USER_HOME: tmp },
        encoding: "utf8",
      }),
    );
    const resolvedRow = resolvedOut.packs
      .find((p) => p.id === "app")
      .artifacts.find((a) => a.coordinate === pinned);
    assert.equal(
      resolvedRow.status,
      "resolved",
      "the pinned version dir present must count as resolved",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('pack-warm.sh rejects unknown pack ids', () => {
  assert.throws(
    () => execFileSync('bash', ['scripts/pack-warm.sh', 'bogus'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    (e) => e.status !== 0 && /pack/i.test(String(e.stderr)),
    'unknown pack must exit non-zero naming the invalid pack',
  );
});

