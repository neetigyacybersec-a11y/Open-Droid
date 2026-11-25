// ISSUE-160: one authoritative MCP verification contract. Linux and Windows
// CI must call it, build once, and never drop or duplicate a mandatory gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(resolve(REPO, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const ci = read(".github/workflows/ci.yml");
const verify = read("scripts/verify.mjs");

const mcpJob = () => ci.slice(ci.indexOf("  mcp:"), ci.indexOf("  mcp-windows:"));
const windowsJob = () => ci.slice(ci.indexOf("  mcp-windows:"), ci.indexOf("  android-matrix:"));

test("verify is the single command used by both CI platforms", () => {
  assert.equal(pkg.scripts.verify, "node scripts/verify.mjs");
  for (const [name, job] of [
    ["mcp", mcpJob()],
    ["mcp-windows", windowsJob()],
  ]) {
    assert.match(job, /node scripts\/verify\.mjs/, `${name} must run the shared verifier`);
    for (const duplicate of [
      /npm run build/,
      /npm test/,
      /node scripts\/test\.mjs/,
      /node --test test\/privacy\.test\.mjs/,
      /npm run (?:architecture|quality|catalogue|typecheck|lint|format:check)/,
      /node scripts\/(?:check-guardrails|check-architecture|quality|tool-catalogue)\.mjs/,
    ]) {
      assert.doesNotMatch(job, duplicate, `${name} duplicates a verify step: ${duplicate}`);
    }
  }
});

test("the verifier includes every mandatory gate exactly once", () => {
  const gates = [
    "typescript/bin/tsc",
    "scripts/lint.mjs",
    "prettier/bin/prettier.cjs",
    "scripts/check-guardrails.mjs",
    "scripts/test.mjs",
    "scripts/check-architecture.mjs",
    "scripts/quality.mjs",
    "scripts/tool-catalogue.mjs",
    "scripts/check-readme.sh",
    "scripts/lifecycle-matrix.mjs",
    "scripts/repo-hygiene.sh",
  ];
  for (const gate of gates) {
    assert.equal(
      verify.split(gate).length - 1,
      1,
      `verify must include ${gate} exactly once (missing or duplicated)`,
    );
  }
});

test("the verifier accepts CRLF checkouts on Windows runners", () => {
  assert.match(
    verify,
    /"--end-of-line",\s*"auto"/,
    "Prettier must not flag LF-normalised files checked out as CRLF",
  );
});

test("the verifier compiles once and runs the full suite once", () => {
  assert.equal(verify.split("scripts/build.mjs").length - 1, 1, "exactly one build");
  assert.equal(verify.split("scripts/test.mjs").length - 1, 1, "exactly one test run");
  assert.doesNotMatch(verify, /npm (?:run )?test/, "no npm shim invokes a second pretest build");
});

test("the required aggregate still fails closed", () => {
  const required = ci.slice(ci.indexOf("  required:"));
  assert.match(required, /if:\s*always\(\)/);
  assert.match(required, /result !== "success"/);
  for (const job of ["mcp", "mcp-windows", "android-matrix", "android-instrumented", "docker", "dependency-review"]) {
    assert.match(required, new RegExp(`\\b${job}\\b`), `required must depend on ${job}`);
  }
});
