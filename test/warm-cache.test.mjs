// ISSUE-14 / FR-D2: warm-cache claims offline builds will resolve, but a warm
// `assembleDebug` alone never proved that a FRESH project building `--offline`
// resolves the AGP plugin marker. The script must end with an offline proof
// build against a fresh copy of the template, after warming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(REPO, 'scripts', 'warm-cache.sh'), 'utf8');
const line = (id) => source.split('\n').findIndex((l) => l.includes(id));

test('warm-cache ends with an offline proof build on a fresh template copy', () => {
  const offlineStep = line('--offline');
  const doneMsg = line('Done');
  assert.ok(offlineStep >= 0, 'warm-cache.sh must invoke gradle with --offline');
  assert.ok(
    /\b(cp -r|rsync)\b/.test(source),
    'offline proof must run on a fresh copy, not the warmed template directory',
  );
  assert.ok(
    offlineStep < doneMsg,
    `--offline proof (line ${offlineStep + 1}) must run before the "Done" message (line ${doneMsg + 1})`,
  );
});

test('warm-cache removes its offline proof artifacts when done', () => {
  assert.match(
    source,
    /rm\s+-rf\s+"\$OFFLINE/,
    'proof artifacts must be cleaned up, not left in the repo',
  );
});
