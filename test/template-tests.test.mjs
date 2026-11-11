// FR-B2 / §11.10: the template ships ZERO tests. Minimum honest slice:
// a JVM Compose (Robolectric) test that runs locally offline, and an instrumented
// Compose test that compiles offline and runs on a device in CI (FR-B6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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

// FR-B2 slice 2 / M2: screenshot (Roborazzi) + a11y (ATF) layers run on the JVM.
test('template declares the Roborazzi test stack', () => {
  for (const coord of [
    'io.github.takahirom.roborazzi:roborazzi',
    'io.github.takahirom.roborazzi:roborazzi-compose',
    'io.github.takahirom.roborazzi:roborazzi-junit-rule',
    'io.github.takahirom.roborazzi:roborazzi-accessibility-check',
  ]) {
    assert.match(appGradle, new RegExp(coord.replace(/\./g, '\\.')), `${coord} must be a template test dependency`);
  }
  assert.match(appGradle, /io\.github\.takahirom\.roborazzi/, 'roborazzi Gradle plugin must be applied for verify/record modes');
});

test('template ships a Roborazzi screenshot test with a committed golden', () => {
  const src = firstKtUnder('test');
  assert.match(src, /captureRoboImage/, 'a screenshot test must capture a Robo image');
  assert.match(src, /src\/test\/screenshots/, 'the capture must target the committed screenshots directory');
  assert.ok(
    existsSync(path.join(REPO, 'templates/compose-starter/app/src/test/screenshots')) &&
      readdirSync(path.join(REPO, 'templates/compose-starter/app/src/test/screenshots')).some((f) => f.endsWith('.png')),
    'a golden PNG must be committed',
  );
});

test('template ships an ATF accessibility-check test', () => {
  const src = firstKtUnder('test');
  assert.match(src, /RoborazziATFAccessibilityChecker/, 'the a11y test must use the Roborazzi ATF checker');
  assert.match(src, /AccessibilityCheckPreset\.LATEST/, 'the a11y test must run the latest ATF preset');
});

// FR-B5: the template theme respects the system — dark follows the system
// setting, and reduced motion is wired via the MotionTokens helper so a user
// who disables system animations gets instant states in Compose too.
test('template theme follows the system dark setting', () => {
  const theme = readFileSync(
    path.join(REPO, 'templates/compose-starter/app/src/main/java/com/example/starter/ui/theme/Theme.kt'),
    'utf8',
  );
  assert.match(theme, /darkTheme:\s*Boolean\s*=\s*isSystemInDarkTheme\(\)/,
    'StarterTheme must default to isSystemInDarkTheme(), not hardcoded false');
  assert.doesNotMatch(theme, /darkTheme:\s*Boolean\s*=\s*false/,
    'the hardcoded light default must be gone');
});

test('template ships motion tokens with reduced-motion wiring (FR-B5)', () => {
  const tokensPath = path.join(REPO, 'templates/compose-starter/app/src/main/java/com/example/starter/ui/motion/MotionTokens.kt');
  assert.ok(existsSync(tokensPath), 'MotionTokens.kt must ship in the template');
  const tokens = readFileSync(tokensPath, 'utf8');
  assert.match(tokens, /LocalReducedMotion/, 'tokens must expose LocalReducedMotion');
  assert.match(tokens, /ANIMATOR_DURATION_SCALE/, 'tokens must read the system animator duration scale');
  const theme = readFileSync(
    path.join(REPO, 'templates/compose-starter/app/src/main/java/com/example/starter/ui/theme/Theme.kt'),
    'utf8',
  );
  assert.match(theme, /MotionSettingsProvider/, 'the theme must install the reduced-motion provider');
});
