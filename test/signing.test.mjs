// FR-B3 / ISSUE-20: the template produces an unsigned, unversioned release APK.
// The scaffold must (a) sign release from keystore.properties when present,
// (b) fail closed when a release task would run without a keystore, and
// (c) derive a monotonic versionCode from git history instead of hardcoding 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const appGradle = readFileSync(path.join(REPO, 'templates/compose-starter/app/build.gradle.kts'), 'utf8');
const versionScript = readFileSync(
  path.join(REPO, 'templates/compose-starter/gradle/version-code.gradle.kts'),
  'utf8',
);

test('release signing comes from gitignored keystore.properties', () => {
  assert.match(appGradle, /keystore\.properties/, 'must read keystore.properties');
  for (const key of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
    assert.match(
      appGradle,
      new RegExp(`["']?${key}["']?`),
      `keystore.properties must supply ${key}`,
    );
  }
});

test('release tasks fail closed when no keystore is configured', () => {
  assert.match(
    appGradle,
    /taskGraph\.whenReady/,
    'must intercept release tasks at task-graph time',
  );
  assert.match(appGradle, /GradleException/, 'must throw, not warn');
  const msg = appGradle.match(/GradleException\(\s*"([^")]+)/s)?.[1] ?? '';
  assert.ok(
    /keystore\.properties/.test(msg),
    'the failure message must tell the user what file is missing',
  );
});

test('versionCode is explicit for release and git-derived only as a dev fallback', () => {
  assert.match(
    appGradle,
    /apply\(from = rootProject\.file\("gradle\/version-code\.gradle\.kts"\)\)/,
    'the app must apply the shared versioning script',
  );
  assert.match(
    appGradle,
    /versionCode = project\.extra\["resolvedVersionCode"\] as Int/,
    'the app must read the resolved version instead of recomputing it',
  );
  assert.match(versionScript, /rev-list.*--count.*HEAD|--count.*rev-list/s);
  assert.match(versionScript, /-PversionCode/, 'an explicit Gradle property must be supported');
  assert.match(versionScript, /VERSION_CODE/, 'an environment override must be supported');
  assert.match(versionScript, /taskNames/, 'release tasks must be detected');
  assert.match(versionScript, /2100000000/, 'the Play upper bound must be enforced');
  assert.ok(!/^versionCode = 1$/m.test(appGradle), 'versionCode must not be hardcoded to 1');
});

test('keystore.properties is ignored by git in the template and the repo root', () => {
  const templateIgnore = readFileSync(
    path.join(REPO, 'templates/compose-starter/.gitignore'),
    'utf8',
  );
  assert.match(templateIgnore, /keystore\.properties/, 'template .gitignore must cover keystore.properties');
  const rootIgnore = readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  assert.match(rootIgnore, /keystore\.properties/, 'root .gitignore must cover keystore.properties');
});
