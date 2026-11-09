// FR-B2 / §11.10: the template ships ZERO tests. Minimum honest slice:
// a JVM Compose (Robolectric) test that runs locally offline, and an instrumented
// Compose test that compiles offline and runs on a device in CI (FR-B6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const appGradle = readFileSync(
  path.join(REPO, 'templates/compose-starter/app/build.gradle.kts'),
  'utf8',
);

function firstKtUnder(sub) {
  const root = path.join(REPO, 'templates/compose-starter/app/src', sub);
  const walk = (dir, out) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith('.kt')) out.push(readFileSync(p, 'utf8'));
    }
    return out;
  };
  const files = walk(root, []);
  return files.length ? files.join('\n') : null;
}

test('template declares the wired test dependencies the offline cache expects', () => {
  for (const coord of ['junit:junit', 'org.robolectric:robolectric', 'androidx.test.ext:junit']) {
    assert.match(
      appGradle,
      new RegExp(`testImplementation\\(["']${coord.replace(/\./g, '\\.')}`),
      `${coord} must be a testImplementation dependency`,
    );
  }
  assert.match(appGradle, /androidTestImplementation\(["']androidx\.compose\.ui:ui-test-junit4/);
  assert.match(
    appGradle,
    /testInstrumentationRunner\s*=\s*"androidx\.test\.runner\.AndroidJUnitRunner"/,
  );
});

test('template ships a JVM Compose (Robolectric) test source', () => {
  const src = firstKtUnder('test');
  assert.ok(src, 'a JVM unit test must exist under app/src/test');
  assert.match(src, /RobolectricTestRunner|AndroidJUnit4/, 'JVM Compose test must run under Robolectric');
  assert.match(src, /createAndroidComposeRule|createComposeRule/, 'JVM Compose test must drive the UI');
});

test('template ships an instrumented Compose test source', () => {
  const src = firstKtUnder('androidTest');
  assert.ok(src, 'an instrumented test must exist under app/src/androidTest');
  assert.match(src, /createAndroidComposeRule|createComposeRule/, 'instrumented Compose test must drive the UI');
});
