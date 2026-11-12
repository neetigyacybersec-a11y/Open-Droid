// Issue 73 [security]: Docker image + setup scripts must not run as root,
// must not pipe unpinned remote content into a shell, and required installs
// must fail closed instead of being silently skipped by `|| true`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const dockerfile = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
const setup = readFileSync(path.join(REPO, 'scripts/setup.sh'), 'utf8');

test('Docker image runs as a non-root user by default (issue 73)', () => {
  const users = [...dockerfile.matchAll(/^USER (\S+)/mg)].map((m) => m[1]);
  assert.ok(users.length > 0, 'Dockerfile must declare a USER');
  assert.notEqual(users[users.length - 1], 'root', 'the last USER must not be root');
});

test('no unpinned `curl | bash` installers in Dockerfile or setup.sh (issue 73)', () => {
  for (const [name, raw] of [['Dockerfile', dockerfile], ['scripts/setup.sh', setup]]) {
    // drop pure comment lines so a prose mention of `| bash` can't trip the scan
    const s = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const m of s.matchAll(/\|\s*bash/g)) {
      const line = s.slice(0, m.index).split('\n').pop() ?? '';
      const context = s.slice(Math.max(0, s.lastIndexOf('\n', m.index - 400)), m.index);
      assert.match(
        context + line,
        /(releases\/download\/|v\d+\.\d+\.\d+|@[0-9a-f]{40}|SHASUMS|sha256)/,
        `${name}: pipe-to-shell must come from a pinned source: ${line.trim()}`,
      );
      assert.doesNotMatch(
        context + line,
        /get\.maestro\.mobile\.dev|nodesource|yschimke\/skills\/main|dl\.google\.com/,
        `${name}: unpinned pipe-to-shell installer: ${line.trim()}`,
      );
    }
  }
});

test('Maestro installs are pinned to a release zip, not the latest installer (issue 73)', () => {
  for (const [name, s] of [['Dockerfile', dockerfile], ['scripts/setup.sh', setup]]) {
    assert.doesNotMatch(s, /get\.maestro\.mobile\.dev[\s\S]{0,80}\|\s*bash/, `${name}: maestro must not use the latest installer`);
    assert.match(s, /maestro\/releases\/download\/(cli-2\.12\.1|\$\{MAESTRO_VERSION\})\/maestro\.zip/, `${name}: maestro must be pinned to the vendored release zip`);
  }
  assert.match(setup, /MAESTRO_VERSION="cli-2\.12\.1"/, 'setup.sh must pin the maestro version literal');
});

test('remote skills installer is commit-pinned, not unpinned main (issue 73)', () => {
  assert.doesNotMatch(setup, /yschimke\/skills\/main\/scripts\/install\.sh/, 'skills installer must not come from the mutable main branch');
  assert.match(setup, /SKILLS_PIN="[0-9a-f]{40}"/, 'skills installer must pin a full commit SHA');
  assert.match(setup, /yschimke\/skills@\$\{SKILLS_PIN\}/, 'skills installer URL must use the pinned SHA');
});

test('required Docker installs fail closed (issue 73)', () => {
  const sdk = dockerfile.slice(dockerfile.indexOf('sdkmanager --licenses'), dockerfile.indexOf('WORKDIR /app'));
  assert.doesNotMatch(sdk, /\|\| true/, 'sdk install steps must not swallow failures with || true');
});

test('android CLI installer is downloaded to a file and executed explicitly (issue 73)', () => {
  assert.doesNotMatch(setup, /dl\.google\.com[\s\S]{0,120}\|\s*bash/, 'android CLI installer must not pipe remote content straight into bash');
  assert.match(setup, /android-cli-install\.sh/, 'android CLI installer must be staged as a file first');
});

test('dev dependency advisory is contained by an explicit override (issue 73)', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.overrides?.minimatch, '^11.0.8', 'minimatch must be overridden past GHSA-g3hv-75wg-m249 (advisory affects typescript-eslint <= 8.72.2, no upstream fix yet)');
});
