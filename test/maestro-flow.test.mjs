// ISSUE-161: the Maestro retry must expose first-attempt results, mark a
// retry-pass as flaky, and preserve diagnostics. No emulator needed here: the
// flow runner is injected, so all three outcomes are deterministic.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFlow } from "../scripts/maestro-smoke.mjs";

function harness(results, nowValues = [0, 100, 200]) {
  const dir = mkdtempSync(join(tmpdir(), "maestro-flow-"));
  let index = 0;
  let clock = 0;
  let diagnostics = 0;
  const result = runFlow({
    argv: ["maestro", "test", "flow.yaml"],
    env: {},
    artifactsDir: dir,
    now: () => nowValues[clock++] ?? 1000,
    execute: () => results[index++] ?? { status: 0, stdout: "", stderr: "" },
    collectDiagnostics: () => {
      diagnostics += 1;
    },
    log: () => undefined,
  });
  return { dir, result, diagnostics: () => diagnostics, attempts: () => index };
}

test("clean first pass runs once and is not reported as flaky", () => {
  const h = harness([{ status: 0, stdout: "ok", stderr: "" }]);
  try {
    assert.equal(h.result.attempts.length, 1);
    assert.equal(h.result.flaky, false);
    assert.equal(h.result.failed, false);
    assert.equal(h.result.exitCode, 0);
    assert.equal(h.diagnostics(), 0);
    assert.match(h.result.summary, /maestro attempt 1: exit=0/);
    assert.match(h.result.summary, /PASSED first attempt/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("retry-pass is marked flaky, not a clean first pass", () => {
  const h = harness([
    { status: 1, stdout: "", stderr: "driver timeout" },
    { status: 0, stdout: "ok", stderr: "" },
  ]);
  try {
    assert.equal(h.result.attempts.length, 2);
    assert.equal(h.result.flaky, true);
    assert.equal(h.result.failed, false);
    assert.equal(h.result.exitCode, 0);
    assert.equal(h.diagnostics(), 1, "flaky runs still collect diagnostics");
    assert.match(h.result.summary, /maestro attempt 1: exit=1/);
    assert.match(h.result.summary, /maestro attempt 2: exit=0/);
    assert.match(h.result.summary, /FLAKY/);
    assert.doesNotMatch(h.result.summary, /PASSED first attempt/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a failure after the single retry fails the job and keeps both attempts", () => {
  const h = harness([
    { status: 1, stdout: "", stderr: "first" },
    { status: 2, stdout: "", stderr: "second" },
  ]);
  try {
    assert.equal(h.result.attempts.length, 2);
    assert.equal(h.result.failed, true);
    assert.equal(h.result.exitCode, 1);
    assert.equal(h.diagnostics(), 1);
    assert.match(h.result.summary, /FAILED after retry/);
    const log1 = readFileSync(join(h.dir, "maestro-attempt-1.log"), "utf8");
    const log2 = readFileSync(join(h.dir, "maestro-attempt-2.log"), "utf8");
    assert.match(log1, /driver|first/);
    assert.match(log2, /second/);
    const meta = JSON.parse(readFileSync(join(h.dir, "maestro-attempts.json"), "utf8"));
    assert.equal(meta.attempts.length, 2);
    assert.equal(meta.failed, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("only one retry is ever attempted (no unbounded loops)", () => {
  const h = harness([
    { status: 1, stdout: "", stderr: "1" },
    { status: 1, stdout: "", stderr: "2" },
    { status: 0, stdout: "should never run", stderr: "" },
  ]);
  try {
    assert.equal(h.attempts(), 2);
    assert.equal(h.result.failed, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});
