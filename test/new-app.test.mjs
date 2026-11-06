// FR-B1 / ISSUE-13: a scaffold without sdk.dir cannot build ("SDK location not found").
// new-app.sh must write local.properties when ANDROID_HOME is set and fail loudly when not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

function scaffold(name, envOverrides) {
  const env = { ...process.env, ...envOverrides };
  delete env.ANDROID_SDK_ROOT; // script must depend on ANDROID_HOME only
  return spawnSync('bash', ['scripts/new-app.sh', name], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  });
}

test('fresh scaffold writes local.properties with sdk.dir from ANDROID_HOME', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'newapp-t1-'));
  const sdk = mkdtempSync(path.join(tmpdir(), 'fake-sdk-'));
  const app = `${work}/demo`;
  try {
    const r = scaffold(app, { ANDROID_HOME: sdk });
    assert.equal(r.status, 0, `scaffold failed: ${r.stderr}`);
    const lp = readFileSync(path.join(app, 'local.properties'), 'utf8');
    assert.match(lp, /^sdk\.dir=/, 'local.properties must set sdk.dir');
    assert.ok(lp.includes(sdk), `sdk.dir must point at ANDROID_HOME (${sdk}), got: ${lp.trim()}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test('scaffold fails loudly when ANDROID_HOME is unset (no silent half-project)', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'newapp-t2-'));
  const app = `${work}/demo`;
  try {
    const r = scaffold(app, { ANDROID_HOME: '' });
    assert.notEqual(r.status, 0, 'must exit non-zero without ANDROID_HOME');
    assert.ok(
      (r.stderr + r.stdout).includes('ANDROID_HOME'),
      'error must mention ANDROID_HOME',
    );
    assert.ok(
      !existsSync(app),
      'must fail before scaffolding, not leave a project that cannot build',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
