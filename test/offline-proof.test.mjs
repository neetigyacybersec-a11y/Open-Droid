// FR-D2: doctor must PROVE offline readiness, not just check that the cache
// directory exists. The proof build lives in scripts/offline-proof.sh and is
// shared by warm-cache.sh (after warming) and doctor.sh (as a hard check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');

test('an offline-proof script exists with the fresh-copy offline build', () => {
  assert.ok(existsSync(path.join(REPO, 'scripts/offline-proof.sh')), 'scripts/offline-proof.sh missing');
  const s = read('scripts/offline-proof.sh');
  assert.ok(s.includes('--offline'), 'proof must build with --offline');
  assert.ok(/\b(cp -r|rsync)\b/.test(s), 'proof must run on a fresh copy of the template');
  assert.ok(/rm\s+-rf\s+"\$PROOF"/.test(s), 'proof copy must be cleaned up on both success and failure');
  assert.ok(s.includes('mkdir -p'), 'proof must create .toolchain before copying (fresh hosts)');
});

test('warm-cache delegates the proof instead of duplicating it', () => {
  const s = read('scripts/warm-cache.sh');
  assert.ok(s.includes('scripts/offline-proof.sh'), 'warm-cache must call scripts/offline-proof.sh');
  // the inline duplicate is gone: no gradle invocation here may carry --offline
  assert.ok(
    !/^\s*gradle .*--offline/m.test(s),
    'warm-cache must not keep its own --offline invocation',
  );
});

test('doctor gates on the offline proof build, not cache-directory presence', () => {
  const s = read('scripts/doctor.sh');
  assert.ok(s.includes('scripts/offline-proof.sh'), 'doctor must call scripts/offline-proof.sh');
  const page = s.split('\n');
  const cacheDirCheck = page.findIndex((l) => l.includes('gradle-home/caches'));
  const proofCall = page.findIndex((l) => l.includes('scripts/offline-proof.sh'));
  assert.ok(cacheDirCheck >= 0 && cacheDirCheck < proofCall,
    'cache-directory warning must still come before the proof build');
  assert.ok(/fail=1/.test(s), 'a failed offline proof must fail doctor (fail=1)');
});

test('warm-cache still guards missing gradle and performs the online warm build', () => {
  const s = read('scripts/warm-cache.sh');
  assert.ok(
    s.includes('command -v gradle') && /exit 1/.test(s),
    'warm-cache must fail loudly when gradle is not installed',
  );
  assert.ok(
    /gradle --no-daemon :app:assembleDebug/.test(s),
    'warm-cache must still perform the online warm build',
  );
});
