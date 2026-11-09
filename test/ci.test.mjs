// FR-B6 / ISSUE-22: CI must build and test every app the repo ships.
// Pin contract: the android matrix job covers hello-app, the compose-starter
// template and vuln-app with assembleDebug + testDebugUnitTest + lintDebug, and
// an instrumented job runs connectedDebugAndroidTest on one API level (35).
// (Screenshot/a11y + Maestro CI jobs are the FR-B2 layer-3 slice, later.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

const matrixJob = ci.slice(ci.indexOf('android-matrix'));

test('android-matrix job covers every shipped app', () => {
  assert.ok(/android-matrix:/.test(ci), 'android-matrix job must exist');
  assert.ok(ci.indexOf('android-matrix') > ci.indexOf('app-build'), 'matrix must come after the old app-build job (or replace it)');
  for (const app of ['hello-compose', 'compose-starter', 'vuln-app']) {
    assert.ok(matrixJob.includes(app), `matrix must include ${app}`);
  }
});

test('android-matrix runs assembleDebug + testDebugUnitTest + lintDebug', () => {
  for (const task of ['assembleDebug', 'testDebugUnitTest', 'lintDebug']) {
    assert.match(matrixJob, new RegExp(task), `matrix steps must run ${task}`);
  }
  assert.ok(matrixJob.includes('-Proborazzi.test.verify=true'), 'template goldens must be verified in CI (FR-B2 slice 2)');
  assert.ok(!ci.includes('--offline'), 'CI resolves online — the offline guarantee is the vendored toolchain, not CI');
});

test('android-instrumented job runs connected tests on API 35', () => {
  assert.ok(ci.includes('android-instrumented:'), 'android-instrumented job must exist');
  const inst = ci.slice(ci.indexOf('android-instrumented:'), ci.indexOf('docker:'));
  assert.ok(inst.includes('connectedDebugAndroidTest'), 'must run connectedDebugAndroidTest');
  assert.ok(inst.includes('android-35') || inst.includes('sysimg'), 'must target API 35');
  assert.ok(inst.includes('runs-on: ubuntu-latest'), 'emulator job must be ubuntu (KVM)');
});
