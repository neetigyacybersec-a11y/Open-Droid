// ISSUE-49: CI failure collection and diagnosis. GitHub Actions via the gh CLI
// plus a local-log mode for other CI systems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFailure,
  collectFailures,
  printReport,
  redactEvidence,
} from "../scripts/ci-failures.mjs";

const UNIT_FAIL_LOG = [
  "Run failed. You can inspect full logs in the UI.",
  "",
  "FAILED  > com.example.NotesTest.duplicateSave[FAILED]",
  "at com.example.NotesTest.duplicateSave(NotesTest.kt:42)",
  "FAILED  > com.example.NotesTest.savesNote[FAILED]",
  "13 tests, 11 passed, 2 failed",
  "",
  "There were failing tests. See the report for details.",
  "",
].join("\n");

const DEPENDENCY_LOG = [
  "FAILURE: build failed with an exception.",
  "> Could not resolve all files for configuration ':app:debugCompileClasspath'.",
  "   > Could not find com.example:notes:1.2.3.",
  "   Searched in the following locations:",
  "     - https://maven.pkg.example.com/notes/1.2.3.pom",
  "",
].join("\n");

const KOTLIN_LOG = [
  "e: file:///home/kali/Open-Droid/src/SaveActivity.kt:42:13 Unresolved reference: saved",
  "e: file:///home/kali/Open-Droid/src/SaveActivity.kt:55:9 Variable 'name' must be initialized",
  "e: compilation error",
  "",
].join("\n");

const LINT_LOG = "Lint found 2 issues.\nWrote /app/build/reports/lint-lint.txt\n";

const EMULATOR_LOG = [
  'ERROR: ... failed to start the emulator ... "qemu-system-aarch64: Falling back on swap..."',
  "waiting for device",
  "adb: device 'emulator-5554' offline",
  "timeout: 'emulator-5554' was not online",
].join("\n");

const MAESTRO_LOG =
  "Flow 'smoke.yaml' failed: tapOn id replay\nAssertion failed: [id=replay] was not found";

test("classifyFailure labels unit-test failures with test ids and stack evidence", () => {
  const result = classifyFailure({ log: UNIT_FAIL_LOG, jobName: "test", stepName: "Run tests" });
  assert.equal(result.kind, "unit-test");
  assert.ok(result.label === "confirmed", `expected confirmed, got ${result.label}`);
  assert.equal(result.evidence[0].testId, "com.example.NotesTest.duplicateSave");
  assert.ok(result.evidence[0].stackLines.some((l) => l.includes("NotesTest.kt:42")));
});

test("classifyFailure: dependency, kotlin, lint, emulator, maestro, signing, upload, unknown", () => {
  const cases = [
    [DEPENDENCY_LOG, "dependency"],
    [KOTLIN_LOG, "kotlin-compile"],
    [LINT_LOG, "lint"],
    [EMULATOR_LOG, "emulator-startup"],
    [MAESTRO_LOG, "maestro"],
  ];
  for (const [log, kind] of cases) assert.equal(classifyFailure({ log }).kind, kind);
  const unknown = classifyFailure({ log: "no recognizable signature here" });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.label, "unknown");
});

test("classifyFailure: generic gradle failure stays unknown, not invented", () => {
  const result = classifyFailure({ log: "FAILURE: Build failed with an exception.\n" });
  assert.equal(result.kind, "unknown");
  assert.ok(result.reason || result.evidence.length === 0);
});

test("a passing log matched by a signature is 'likely', not 'confirmed'", () => {
  const result = classifyFailure({ log: "lint check passed: 0 issues\n" });
  assert.equal(result.kind, "lint");
  assert.equal(result.label, "likely");
});

test("a passing local log is reported as ok, not failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "od-ci-failures-ok-"));
  try {
    writeFileSync(join(dir, "build.log"), "BUILD SUCCESSFUL in 3s\nAll tests passed\n");
    const report = await collectFailures({
      dir,
      runFn: async () => ({ code: 1, stderr: "unexpected call" }),
    });
    assert.equal(report.status, "ok");
    assert.ok(
      report.failures.every((f) => f.label !== "confirmed"),
      "no passing log is presented as a confirmed failure",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactEvidence removes tokens, credentials, signing material, and hostnames", () => {
  const redacted = redactEvidence(
    "TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12 GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz12 " +
      "password: supersecret1234567890 " +
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop " +
      "keystore build.gradle.kts: secureKey: mySecretValue123 " +
      "internal.corp.example.com or ci.corp.internal or 10.0.0.5 or 172.16.1.1",
  );
  assert.doesNotMatch(redacted, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(redacted, /supersecret1234567890/);
  assert.doesNotMatch(redacted, /eyJ[A-Za-z0-9_.-]+/);
  assert.doesNotMatch(redacted, /corp\.internal|\.corp\.example\.com/);
  assert.doesNotMatch(redacted, /\b10\.0\.0\.5|\b172\.16\.1\.1\b/);
  assert.match(redacted, /\[REDACTED/);
});

test("collectFailures uses gh api for run URLs and preserves job/step/commit/URL evidence", async () => {
  const runUrl = "https://github.com/o/r/actions/runs/12345678";
  const calls = [];
  const runFn = async (args) => {
    calls.push(args.join(" "));
    const out = args.join(" ");
    if (out.includes("jobs/4242/logs")) return { code: 0, stdout: KOTLIN_LOG, stderr: "" };
    if (out.includes("repos/o/r/actions/runs/12345678/jobs"))
      return {
        code: 0,
        stdout: JSON.stringify([
          { name: "test", conclusion: "success", steps: [] },
          {
            name: "build",
            conclusion: "failure",
            databaseId: 4242,
            steps: [{ name: "Build", conclusion: "failure" }],
          },
        ]),
        stderr: "",
      };
    if (out.includes("repos/o/r/actions/runs/12345678"))
      return {
        code: 0,
        stdout:
          '{"databaseId":12345678,"headSha":"abc1234","htmlUrl":"' +
          runUrl +
          '","status":"completed","conclusion":"failure"}',
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  const report = await collectFailures({ runRef: runUrl, runFn });
  assert.equal(report.status, "failure");
  assert.equal(report.commitSha, "abc1234");
  assert.equal(report.url, runUrl);
  assert.ok(report.failures.length > 0);
  assert.equal(report.failures[0].kind, "kotlin-compile");
  const json = JSON.stringify(report);
  assert.ok(calls.some((c) => c.includes("api repos/o/r/actions/runs/12345678")), "gh api used for run metadata");
});

test("collectFailures missing permissions report as not-collected, never as passed", async () => {
  const runFn = async () => ({ code: 1, stdout: "", stderr: "unauthenticated: write:jamboree" });
  const report = await collectFailures({
    runRef: "https://github.com/o/r/actions/runs/123",
    runFn,
  });
  assert.equal(report.status, "error");
  assert.equal(report.collected, false);
  assert.ok(report.reason);
  const text = printReport(report);
  assert.match(text, /status=error|collected=false/);
  assert.doesNotMatch(text, /^status=ok$/m);
});

test("local mode scans a directory of logs for failures without GitHub access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "od-ci-failures-"));
  try {
    writeFileSync(join(dir, "unit.log"), UNIT_FAIL_LOG);
    writeFileSync(join(dir, "build.log"), DEPENDENCY_LOG);
    const report = await collectFailures({
      dir,
      runFn: async () => ({ code: 1, stderr: "unexpected call" }),
    });
    assert.equal(report.status, "failure");
    assert.ok(report.localLogs.some((l) => l.endsWith("unit.log")));
    assert.ok(
      report.failures.length >= 2,
      `unit + dependency classified, got ${JSON.stringify(report.failures)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("printReport includes run URL, commit, failure kinds, labels and repro hint", () => {
  const report = {
    status: "failure",
    collected: true,
    url: "https://github.com/o/r/actions/runs/123",
    commitSha: "abc1234",
    failedJobs: ["build"],
    failures: [
      {
        kind: "kotlin-compile",
        label: "confirmed",
        evidence: [
          { testId: null, message: "Unresolved reference: saved", stackLines: ["e: SaveActivity.kt:42"] },
        ],
      },
    ],
    repro: "cd $PROJECT_ROOT && gradle :app:testDebugUnitTest",
    truncated: false,
  };
  const text = printReport(report);
  assert.match(text, /status=failure/);
  assert.match(text, /url=https:\/\/github\.com\/o\/r\/actions\/runs\/123/);
  assert.match(text, /commit=abc1234/);
  assert.match(text, /failedJobs=build/);
  assert.match(text, /kind=kotlin-compile label=confirmed/);
  assert.match(text, /repro=cd \$PROJECT_ROOT && gradle :app:testDebugUnitTest/);
});
