// FR-B6 / ISSUE-22: CI must build and test every app the repo ships.
// Pin contract: the android matrix job covers hello-app, the compose-starter
// template and vuln-app with assembleDebug + testDebugUnitTest + lintDebug, and
// an instrumented job runs connectedDebugAndroidTest on one API level (35).
// (Screenshot/a11y + Maestro CI jobs are the FR-B2 layer-3 slice, later.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

const matrixJob = ci.slice(ci.indexOf('android-matrix'));

// ISSUE-160: CI invokes one shared verifier; its mandatory gates are tested
// in test/verify-contract.test.mjs so Linux and Windows cannot drift apart.
test('mcp job runs the shared verifier (issues 71, 135, 160)', () => {
  const mcp = ci.slice(ci.indexOf('mcp:'), ci.indexOf('mcp-windows:'));
  assert.ok(mcp.includes('node scripts/verify.mjs'), 'mcp job must run the shared verifier');
});

test('mcp-windows job runs the same shared verifier (issue 160)', () => {
  const win = ci.slice(ci.indexOf('mcp-windows:'), ci.indexOf('android-matrix:'));
  assert.ok(win.includes('node scripts/verify.mjs'), 'Windows must run the same verifier');
});
// ISSUE-162: superseded PR runs are cancelled, but main/release runs are not.
test('workflow concurrency keys PRs separately from main and releases (issue 162)', () => {
  const topBlock = ci.slice(0, ci.indexOf('mcp:'));
  assert.match(topBlock, /concurrency:/, 'ci.yml must declare a concurrency group');
  assert.match(topBlock, /github\.event\.pull_request\.number/, 'PR runs key on PR identity');
  assert.match(topBlock, /cancel-in-progress:/, 'PR cancellation must be explicit');
  assert.doesNotMatch(topBlock, /cancel-in-progress:\s*true\s*$/m, 'main pushes must not be cancelled');
  const releases = readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');
  assert.match(releases, /concurrency:/, 'release runs need a separate group');
  assert.doesNotMatch(releases, /cancel-in-progress:\s*true/, 'release runs must not be cancelled');
});

test('guardrail skip exception is scoped to the skip line (issue 135)', () => {
  const source = readFileSync(path.join(REPO, 'scripts/check-guardrails.mjs'), 'utf8');
  assert.ok(!source.includes('text.includes("process.platform")'), 'a platform mention elsewhere in the file must not whitelist every skip');
});
test('android-matrix job covers every shipped app', () => {
  assert.ok(/android-matrix:/.test(ci), 'android-matrix job must exist');
  assert.ok(ci.indexOf('android-matrix') > ci.indexOf('app-build'), 'matrix must come after the old app-build job (or replace it)');
  for (const app of ['hello-compose', 'compose-starter', 'vuln-app']) {
    assert.ok(matrixJob.includes(app), `matrix must include ${app}`);
  }
  // Regression pin (CI run 42685876691): the hello-compose entry lacked the
  // examples/ prefix and `cd hello-compose` failed on the runner. Every
  // app-dir entry must be a real directory containing a gradle app module.
  const entries = [...matrixJob.matchAll(/^\s{10}(- .+)$/gm)].map((m) => m[1].slice(2));
  const appDirs = entries.filter((entry) => !entry.startsWith("'") && !entry.includes(':'));
  assert.ok(appDirs.length >= 3, `matrix must list app dirs, found: ${appDirs.join(', ')}`);
  for (const dir of appDirs) {
    assert.ok(existsSync(path.join(REPO, dir, 'app/build.gradle.kts')), `matrix entry ${dir} must be an app directory with app/build.gradle.kts`);
  }
});

test('android-instrumented job grants KVM before booting the emulator', () => {
  assert.ok(ci.includes('99-kvm4all.rules'), 'the KVM udev rule must be installed (run 42685876691: software-mode emulator caused a startup ANR reported as "Process crashed")');
  assert.ok(ci.includes('test -w /dev/kvm'), 'the job must fail closed if KVM is still not writable');
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

// FR-B2 slice 3 / M2 exit criterion: "at least one committed Maestro flow run
// in CI". The template ships a smoke flow; the instrumented emulator session
// runs it after the connected test.
test('template ships a committed Maestro smoke flow (FR-B2 slice 3)', () => {
  const flowPath = path.join(REPO, 'templates/compose-starter/maestro/smoke.yaml');
  assert.ok(existsSync(flowPath), 'maestro/smoke.yaml must ship in the template');
  const flow = readFileSync(flowPath, 'utf8');
  assert.match(flow, /appId:\s*com\.example\.starter/, 'the flow must target the template app id');
  assert.match(flow, /launchApp/, 'the flow must launch the app');
  assert.match(flow, /assertVisible/, 'the flow must assert real UI content');
});

test('CI runs the Maestro smoke flow in the emulator session (FR-B2 slice 3)', () => {
  const inst = ci.slice(ci.indexOf('android-instrumented:'), ci.indexOf('docker:'));
  assert.ok(inst.includes('node scripts/maestro-smoke.mjs'), 'the emulator job must call the flow runner');
  assert.ok(inst.includes(':app:installDebug'), 'the app must be reinstalled before the flow (AGP uninstalls after connected tests)');
  const flow = readFileSync(path.join(REPO, 'scripts/maestro-smoke.mjs'), 'utf8');
  assert.match(flow, /"maestro", "test"/, 'the runner must invoke the Maestro CLI');
  assert.match(flow, /templates\/compose-starter\/maestro\/smoke\.yaml/, 'the committed flow must be used');
});

test('CI uploads bounded Maestro diagnostics for failed or flaky runs (issue 161)', () => {
  const inst = ci.slice(ci.indexOf('android-instrumented:'), ci.indexOf('docker:'));
  assert.match(inst, /actions\/upload-artifact@[0-9a-f]{40}/, 'diagnostics need a pinned upload action');
  assert.match(inst, /path:\s*maestro-artifacts\//, 'upload the runner artifacts');
  assert.match(inst, /retention-days:\s*\d+/, 'artifact retention must be bounded');
  assert.match(inst, /if:\s*always\(\)/, 'upload must run after a failure too');
});

test('maestro driver startup timeout is in milliseconds and the driver port is pinned (runs 43162090162)', () => {
  const flow = readFileSync(path.join(REPO, 'scripts/maestro-smoke.mjs'), 'utf8');
  // AndroidDriver.getStartupTimeout parses milliseconds with no unit
  // conversion; a seconds-looking 180 gives a 180 ms awaitLaunch window.
  for (const m of flow.matchAll(/MAESTRO_DRIVER_STARTUP_TIMEOUT["']?\s*[:=]\s*["']?(\d+)/g)) {
    assert.ok(Number(m[1]) >= 60000, `driver startup timeout must be milliseconds (got ${m[1]})`);
  }
  const port = flow.match(/"--driver-host-port",\s*"(\d+)"/);
  assert.ok(port, 'the driver port must be pinned (upstream maestro #3684)');
  assert.ok(Number(port[1]) < 32768, 'the pinned driver port must be below the 32768-60999 device ephemeral range');
});

// ---------------------------------------------------------------------------
// Issue 72 [security]: workflow hardening — least-privilege permissions,
// SHA-pinned actions, gated publishing with provenance.
// ---------------------------------------------------------------------------

const rel = readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8');

test('workflows declare least-privilege permissions (issue 72)', () => {
  const topBlock = ci.slice(0, ci.indexOf('mcp:'));
  assert.match(topBlock, /permissions:\s*\n\s*contents: read/, 'ci.yml must set a workflow-level least-privilege permissions block');
  assert.match(rel, /permissions:/, 'release.yml must declare explicit permissions');
  assert.match(rel.slice(rel.indexOf('npm:')), /contents: read/, 'the npm publish job must not get broad default permissions');
  assert.match(rel.slice(rel.indexOf('npm:')), /id-token: write/, 'npm provenance requires id-token: write on the publish job');
});

test('third-party actions are pinned to full commit SHAs (issue 72)', () => {
  for (const wf of [ci, rel]) {
    for (const m of wf.matchAll(/uses:\s*(\S+)/g)) {
      const ref = m[1];
      assert.match(ref, /@[0-9a-f]{40}( # v\d.*)?$/, `action must be SHA-pinned, got: ${ref}`);
    }
  }
});

test('publishing is gated on a validate job and uses npm provenance (issue 72)', () => {
  const npmJob = rel.slice(rel.indexOf('npm:'));
  assert.match(rel, /validate:/, 'release.yml must have an explicit validate job (build + tests)');
  assert.match(npmJob, /needs:\s*\[?['"]?validate/, 'npm publish must depend on the validate job');
  assert.match(rel.slice(rel.indexOf('docker:')), /needs:\s*\[?['"]?validate/, 'docker publish must depend on the validate job');
  assert.match(npmJob, /--provenance/, 'npm publish must enable provenance');
  assert.match(rel.slice(rel.indexOf('validate:')), /npm test/, 'the validate job must run the test suite');
  assert.match(rel.slice(rel.indexOf('docker:')), /environment:/, 'docker publish must run in a named environment (approval gate target)');
  assert.match(npmJob, /environment:/, 'npm publish must run in a named environment (approval gate target)');
});

// ---------------------------------------------------------------------------
// Issue 107 [supply-chain]: dependency and build-system changes must be
// visible in CI, fail on high risk, and route protected files to review.
// ---------------------------------------------------------------------------

test('dependency-review job inspects full history and publishes a summary (issue 107)', () => {
  assert.ok(ci.includes('dependency-review:'), 'ci.yml must define a dependency-review job');
  const job = ci.slice(ci.indexOf('dependency-review:'), ci.indexOf('mcp-windows:'));
  assert.match(job, /fetch-depth:\s*0/, 'the job needs full history to resolve a push base');
  assert.match(job, /scripts\/dependency-review\.mjs/, 'the job must run the shipped checker');
  assert.match(job, /--format markdown/, 'the job must render a human-readable report');
  assert.match(job, /--fail-on high/, 'the job must block high-risk changes');
  assert.match(job, /github\.event\.pull_request\.base\.sha/, 'pull requests must diff against the PR base');
  assert.match(job, /github\.event\.before/, 'pushes must diff against the previous commit');
  assert.match(job, /\^0\+\$/, 'new branches must fall back when the before SHA is all zeroes');
  assert.match(job, /git fetch/, 'a missing base commit must be fetched');
  assert.match(job, /GITHUB_STEP_SUMMARY/, 'the report must be published to the job summary');
  assert.match(job, /exit "\$status"/, 'the checker exit status must still fail the job');
});

test('CODEOWNERS protects dependency, build, wrapper and CI files (issue 107)', () => {
  const ownersPath = path.join(REPO, '.github/CODEOWNERS');
  assert.ok(existsSync(ownersPath), '.github/CODEOWNERS must exist');
  const owners = readFileSync(ownersPath, 'utf8');
  for (const pattern of [
    'package.json',
    '**/package.json',
    'package-lock.json',
    'build.gradle.kts',
    '**/build.gradle.kts',
    'settings.gradle.kts',
    '**/settings.gradle.kts',
    'gradle/*.versions.toml',
    'gradle/wrapper/gradle-wrapper.properties',
    'gradle/wrapper/gradle-wrapper.jar',
    'gradle/verification-metadata.xml',
    '.npmrc',
    'pom.xml',
    '.github/workflows/*.yml',
  ]) {
    assert.ok(owners.includes(pattern), `CODEOWNERS must cover ${pattern}`);
  }
  assert.match(owners, /@[A-Za-z0-9-]+/, 'CODEOWNERS must name a real owner');
});
