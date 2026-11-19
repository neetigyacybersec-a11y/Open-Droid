// ISSUE-122: versionCode must be explicit for release builds and validated.
// These tests execute the same applied Gradle script the starter uses, in an
// isolated fixture with no Android plugins, so they run offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const VERSION_SCRIPT = join(
  REPO,
  "templates",
  "compose-starter",
  "gradle",
  "version-code.gradle.kts",
);

function resolveGradle() {
  if (process.env.GRADLE_BIN) return process.env.GRADLE_BIN;
  const vendored = join(REPO, ".toolchain", "gradle", "bin", "gradle");
  if (existsSync(vendored)) return vendored;
  const probe = spawnSync("gradle", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "gradle" : null;
}

const GRADLE = resolveGradle();
const skip = GRADLE ? false : "Gradle is not available on this host";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "version-code-"));
  writeFileSync(join(dir, "settings.gradle.kts"), 'rootProject.name = "version-fixture"\n');
  writeFileSync(
    join(dir, "build.gradle.kts"),
    `apply(from = File(providers.gradleProperty("versionScript").get()))

tasks.register("assembleRelease")
tasks.register("printVersionCode") {
    doLast { println(project.extra["resolvedVersionCode"]) }
}
`,
  );
  return dir;
}

function run(dir, args = [], env = {}) {
  return spawnSync(
    GRADLE,
    [
      "-q",
      "--offline",
      "--no-daemon",
      "-p",
      dir,
      `-PversionScript=${VERSION_SCRIPT}`,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, VERSION_CODE: "", ...env },
    },
  );
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("explicit -PversionCode is used verbatim", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, ["printVersionCode", "-PversionCode=1234"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "1234");
});

test("VERSION_CODE supplies the version when the Gradle property is absent", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, ["printVersionCode"], { VERSION_CODE: "77" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "77");
});

test("-PversionCode wins over VERSION_CODE", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, ["printVersionCode", "-PversionCode=50"], { VERSION_CODE: "77" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "50");
});

test("zero, negative, non-numeric and overflowing codes are rejected", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const value of ["0", "-3", "abc", "2100000001", "999999999999"]) {
    const result = run(dir, ["printVersionCode", `-PversionCode=${value}`]);
    assert.notEqual(result.status, 0, `${value} must fail`);
    assert.match(result.stderr + result.stdout, /versionCode|VERSION_CODE/, value);
  }
});

test("a release task without an explicit code fails closed", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, ["assembleRelease"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /explicit version code/i);
});

test("two release builds can carry strictly increasing explicit codes", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = run(dir, ["assembleRelease", "printVersionCode", "-PversionCode=100"]);
  const second = run(dir, ["assembleRelease", "printVersionCode", "-PversionCode=101"]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(first.stdout.trim(), "100");
  assert.equal(second.stdout.trim(), "101");
});

test("a repository without Git metadata falls back to 1", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, ["printVersionCode"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "1");
});

test("full history uses the commit count as the development fallback", { skip }, (t) => {
  const dir = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "commit", "-q", "--allow-empty", "-m", "second");
  const result = run(dir, ["printVersionCode"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "2");
});

test("a depth-1 clone reports a shallow count and still needs an explicit release code", { skip }, (t) => {
  const origin = fixture();
  const clone = mkdtempSync(join(tmpdir(), "version-code-clone-"));
  t.after(() => {
    rmSync(origin, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  });
  git(origin, "init", "-q");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "Test");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "first");
  git(origin, "commit", "-q", "--allow-empty", "-m", "second");
  rmSync(clone, { recursive: true, force: true });
  git(tmpdir(), "clone", "-q", "--depth", "1", `file://${origin}`, clone);

  const fallback = run(clone, ["printVersionCode"]);
  assert.equal(fallback.status, 0, fallback.stderr || fallback.stdout);
  assert.equal(fallback.stdout.trim(), "1", "depth-1 history reports one commit");

  const release = run(clone, ["assembleRelease"]);
  assert.notEqual(release.status, 0);
  assert.match(release.stderr + release.stdout, /explicit version code/i);
});
