// ISSUE-18/19: Windows users hit the PowerShell execution policy with npm
// scripts, and make/bash entry points are absent. Ship node entry points that
// work in a restricted PowerShell, and document the Git Bash/WSL2 requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const node = (script, args = []) =>
  spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: "utf8",
  });

test("scripts/test.mjs lists the same test files as the npm script", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const expected = pkg.scripts.test.replace(/^node --test\s+/, "").split(/\s+/);
  const r = node("scripts/test.mjs", ["--list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), expected);
  assert.match(pkg.scripts.test, /net-capture\.test\.mjs/);
});

test("scripts/build.mjs invokes typescript without a shell", () => {
  const r = node("scripts/build.mjs", ["--print-command"]);
  assert.equal(r.status, 0, r.stderr);
  const command = JSON.parse(r.stdout);
  assert.equal(command[0], process.execPath);
  assert.match(command[1], /typescript[\\/]bin[\\/]tsc$/);
  assert.deepEqual(command.slice(2), ["-p", "tsconfig.json"]);

  const check = node("scripts/build.mjs", ["--noEmit", "--print-command"]);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout).slice(2), ["--noEmit", "-p", "tsconfig.json"]);
});

test("scripts/doctor.mjs is a native Windows alternative to make doctor", () => {
  const help = node("scripts/doctor.mjs", ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /node scripts\/doctor\.mjs/);

  const source = readFileSync(path.join(REPO, "scripts/doctor.mjs"), "utf8");
  assert.doesNotMatch(source, /child_process[^\n]*\b(bash|sh)\b/);
  // It must still report the things the shell doctor gates on.
  for (const check of ["android_env", "gradle", "adb", "emulator", "avd-geometry.mjs"]) {
    assert.ok(source.includes(check), `doctor.mjs must reference ${check}`);
  }
});

test("docs/windows.md documents restricted-PowerShell and Git Bash/WSL2 paths", () => {
  const doc = path.join(REPO, "docs/windows.md");
  assert.ok(existsSync(doc), "docs/windows.md must exist");
  const text = readFileSync(doc, "utf8");
  assert.match(text, /node scripts\/build\.mjs/);
  assert.match(text, /node scripts\/test\.mjs/);
  assert.match(text, /node scripts\/doctor\.mjs/);
  assert.match(text, /npm\.cmd/);
  assert.match(text, /Git Bash|WSL2/);
  assert.match(text, /make setup/);
  assert.match(text, /PowerShell/i);
});

test("README links the Windows entry points and the Windows CI job uses them", () => {
  const readme = readFileSync(path.join(REPO, "README.md"), "utf8");
  assert.match(readme, /docs\/windows\.md/);

  const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
  const windowsJob = ci.slice(ci.indexOf("mcp-windows:"), ci.indexOf("android-matrix:"));
  assert.match(windowsJob, /node scripts\/build\.mjs/);
  assert.match(windowsJob, /node scripts\/test\.mjs/);
  assert.doesNotMatch(windowsJob, /npm run (build|test)/);
});
