// ISSUE-33: evidence-backed test failure diagnosis, local flaky history, bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeTestFailure,
  buildFailureBundle,
  flakyTestHistory,
  parseJUnitXml,
  recordTestOutcome,
  redactDiagnosticText,
} from "../dist/testDiagnostics.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.NotesTest" tests="2" failures="1">
  <testcase name="savesNote" classname="com.example.NotesTest" time="0.12"/>
  <testcase name="duplicateSave" classname="com.example.NotesTest" time="0.31">
    <failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="junit.framework.AssertionFailedError">java.lang.AssertionError: expected: &lt;1&gt; but was: &lt;2&gt;
  at com.example.NotesTest.duplicateSave(NotesTest.kt:42)</failure>
  </testcase>
</testsuite>`;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "od-testdiag-"));
  writeFileSync(join(dir, "results.xml"), xml);
  return dir;
}

function envFor(dir) {
  const old = process.env.ANDROID_MCP_TEST_HISTORY_DIR;
  process.env.ANDROID_MCP_TEST_HISTORY_DIR = join(dir, "history");
  return () => {
    if (old === undefined) delete process.env.ANDROID_MCP_TEST_HISTORY_DIR;
    else process.env.ANDROID_MCP_TEST_HISTORY_DIR = old;
  };
}

test("JUnit XML parser extracts cases, status, message, stack and duration", () => {
  const cases = parseJUnitXml(xml);
  assert.equal(cases.length, 2);
  const passed = cases.find((c) => c.name === "savesNote");
  const failed = cases.find((c) => c.name === "duplicateSave");
  assert.equal(passed.status, "passed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.testId, "com.example.NotesTest.duplicateSave");
  assert.equal(failed.durationMs, 310);
  assert.match(failed.message, /expected: <1> but was: <2>/);
  assert.match(failed.stack, /NotesTest\.kt:42/);
});

test("assertion failure produces exact id, evidence, high-confidence hypothesis and next step", () => {
  const dir = workspace();
  try {
    const report = analyzeTestFailure({ reportPath: join(dir, "results.xml") });
    assert.equal(report.status, "assertion-failure");
    assert.equal(report.testId, "com.example.NotesTest.duplicateSave");
    assert.equal(report.source, join(dir, "results.xml"));
    assert.match(report.observed, /expected: <1> but was: <2>/);
    assert.ok(report.stackLines.length > 0);
    assert.ok(report.hypotheses.some((h) => /assertion/i.test(h.cause) && h.confidence === "high"));
    assert.ok(report.evidence.some((e) => e.includes("results.xml")));
    assert.ok(report.nextStep.length > 10);
    assert.equal(report.insufficientEvidence, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logcat correlation identifies crashes and ANRs with explicit confidence", () => {
  const dir = workspace();
  try {
    const logPath = join(dir, "logcat.txt");
    writeFileSync(logPath, "FATAL EXCEPTION: main\njava.lang.IllegalStateException: bad state\n");
    const report = analyzeTestFailure({ reportPath: join(dir, "results.xml"), logcatPath: logPath });
    assert.ok(report.hypotheses.some((h) => /crash/i.test(h.cause)));
    assert.ok(report.evidence.some((e) => e.includes("logcat.txt")));

    writeFileSync(logPath, "ActivityManager: ANR in com.example.Notes\n");
    const anr = analyzeTestFailure({ reportPath: join(dir, "results.xml"), logcatPath: logPath });
    assert.ok(anr.hypotheses.some((h) => /ANR|not responding/i.test(h.cause)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout and missing report are honest states, not invented root causes", () => {
  const dir = workspace();
  try {
    writeFileSync(
      join(dir, "results.xml"),
      xml.replace('expected: &lt;1&gt; but was: &lt;2&gt;', "test timed out after 30000 ms"),
    );
    const timeout = analyzeTestFailure({ reportPath: join(dir, "results.xml") });
    assert.equal(timeout.status, "timeout");

    const missing = analyzeTestFailure({ reportPath: join(dir, "missing.xml") });
    assert.equal(missing.insufficientEvidence, true);
    assert.ok(missing.unknowns.some((u) => /report|evidence/i.test(u)));
    assert.match(missing.nextStep, /report|evidence/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the word timeout inside an assertion message is not a timeout diagnosis", () => {
  const dir = workspace();
  try {
    writeFileSync(
      join(dir, "results.xml"),
      xml.replace('expected: &lt;1&gt; but was: &lt;2&gt;', "expected timeout=5000 but was 3000"),
    );
    const report = analyzeTestFailure({ reportPath: join(dir, "results.xml") });
    assert.notEqual(report.status, "timeout");
    assert.ok(
      !report.hypotheses.some((h) => /timed out/i.test(h.cause)),
      "no high-confidence timeout hypothesis from an assertion message",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets, internal hosts and user home paths are redacted by default", () => {
  const safe = redactDiagnosticText(
    "token=ghp_abcdefghijklmnopqrstuvwxyz123456 from /home/alice/app ci.corp.internal",
  );
  assert.doesNotMatch(safe, /ghp_[A-Za-z0-9]+/);
  assert.doesNotMatch(safe, /corp\.internal/);
  assert.doesNotMatch(safe, /\/home\/alice/);
  assert.match(safe, /\[REDACTED/);
});

test("flaky status requires repeated inconsistent outcomes in the same environment", () => {
  const dir = workspace();
  const restoreEnv = envFor(dir);
  try {
    const outcomes = [
      ["pass", "pass", "pass", "pass", "pass", "pass"],
      ["fail"],
      ["pass", "fail", "pass", "fail", "pass", "fail"],
    ];
    for (const [i, series] of outcomes.entries()) {
      for (const status of series) {
        recordTestOutcome({
          testId: `com.example.Case${i}.run`,
          status,
          environment: { deviceId: "emulator-5554", apiLevel: "35", variant: "debug" },
        });
      }
    }
    const history = flakyTestHistory({ minRuns: 4 });
    assert.equal(history.length, 1, "only the repeated inconsistent test is flaky");
    assert.equal(history[0].testId, "com.example.Case2.run");
    assert.equal(history[0].passes, 3);
    assert.equal(history[0].failures, 3);
    assert.ok(history[0].evidence.length > 0);
    assert.equal(flakyTestHistory({ testId: "com.example.Case0.run", minRuns: 4 }).length, 0);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flaky dimensions keep different environments separate", () => {
  const dir = workspace();
  const restoreEnv = envFor(dir);
  try {
    for (const [api, status] of [["34", "pass"], ["35", "fail"]]) {
      recordTestOutcome({
        testId: "com.example.VersionSensitive.run",
        status,
        environment: { deviceId: "emulator-5554", apiLevel: api },
      });
    }
    assert.equal(flakyTestHistory({ minRuns: 2 }).length, 0, "one run per environment is not flaky");
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bundle writes a redacted, inspectable artifact with metadata and evidence paths", () => {
  const dir = workspace();
  const restoreEnv = envFor(dir);
  try {
    const bundle = buildFailureBundle({
      reportPath: join(dir, "results.xml"),
      testId: "com.example.NotesTest.duplicateSave",
      metadata: { commit: "abc1234", variant: "debug", apiLevel: "35" },
    });
    assert.ok(bundle.path, "bundle path is returned");
    const text = readFileSync(bundle.path, "utf8");
    assert.match(text, /com\.example\.NotesTest\.duplicateSave/);
    assert.match(text, /abc1234/);
    assert.match(text, /results\.xml/);
    assert.match(text, /generatedAt/);
    assert.match(text, /## Evidence/);
    assert.doesNotMatch(text, /ghp_[A-Za-z0-9]+/);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testsuites wrapper, error and skipped cases parse without dropping entries", () => {
  const wrapped = `<?xml version="1.0"?><testsuites><testsuite name="suite">
  <testcase name="ok" classname="s.Suite" time="0.01"/>
  <testcase name="boom" classname="s.Suite" time="0.5">
    <error message="runtime exploded" type="java.lang.RuntimeException">at s.Suite.boom(Suite.kt:9)</error>
  </testcase>
  <testcase name="later" classname="s.Suite"><skipped/></testcase>
</testsuite></testsuites>`;
  const cases = parseJUnitXml(wrapped);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((c) => c.status), ["passed", "failed", "skipped"]);
  assert.equal(cases[1].testId, "s.Suite.boom");
  assert.equal(cases[1].durationMs, 500);
  assert.match(cases[1].message, /runtime exploded/);
  assert.match(cases[1].stack, /Suite\.kt:9/);
});

test("evidence, hypotheses and unknowns stay separate across report states", () => {
  const dir = workspace();
  try {
    const report = analyzeTestFailure({ reportPath: join(dir, "results.xml") });
    assert.ok(report.evidence.length > 0);
    assert.ok(report.hypotheses.length > 0);
    assert.ok(Array.isArray(report.unknowns));
    assert.equal(report.insufficientEvidence, false);

    const missing = analyzeTestFailure({ reportPath: join(dir, "missing.xml") });
    assert.equal(missing.hypotheses.length, 0, "no hypothesis without evidence");
    assert.equal(missing.evidence.length, 0);
    assert.ok(missing.unknowns.length > 0);
    assert.equal(missing.insufficientEvidence, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logcat lines matching the test or package are preferred as evidence", () => {
  const dir = workspace();
  try {
    const logPath = join(dir, "logcat.txt");
    writeFileSync(
      logPath,
      [
        "FATAL EXCEPTION in com.other.App",
        "FATAL EXCEPTION: main",
        "java.lang.IllegalStateException at com.example.NotesTest.duplicateSave",
      ].join("\n"),
    );
    const report = analyzeTestFailure({
      reportPath: join(dir, "results.xml"),
      logcatPath: logPath,
      metadata: { packageName: "com.example" },
    });
    const crash = report.hypotheses.find((h) => /crash/i.test(h.cause));
    assert.ok(crash, "crash hypothesis is present");
    assert.match(crash.evidence[0], /com\.example\.NotesTest|com\.other\.App/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history store is versioned with retention and project exclusions", () => {
  const dir = workspace();
  const saved = {
    dir: process.env.ANDROID_MCP_TEST_HISTORY_DIR,
    keep: process.env.ANDROID_MCP_TEST_HISTORY_KEEP,
    exclude: process.env.ANDROID_MCP_TEST_EXCLUDE_IDS,
  };
  process.env.ANDROID_MCP_TEST_HISTORY_DIR = join(dir, "history");
  process.env.ANDROID_MCP_TEST_HISTORY_KEEP = "3";
  process.env.ANDROID_MCP_TEST_EXCLUDE_IDS = "skip.me";
  try {
    for (const status of ["pass", "fail", "pass", "fail", "pass"]) {
      recordTestOutcome({ testId: "com.example.Keep.run", status });
    }
    recordTestOutcome({ testId: "skip.me", status: "fail" });
    const lines = readFileSync(join(dir, "history", "outcomes.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 3, "retention caps stored outcomes");
    assert.ok(lines.every((line) => line.v === 1), "records are versioned");
    assert.ok(lines.every((line) => line.testId === "com.example.Keep.run"));
    assert.equal(flakyTestHistory({ testId: "skip.me", minRuns: 2 }).length, 0, "excluded ID is not stored");
    assert.equal(
      flakyTestHistory({ minRuns: 3, excludeTestIds: ["com.example.Keep.run"] }).length,
      0,
      "explicit exclusions are honoured at query time",
    );
  } finally {
    for (const [key, value] of Object.entries({
      ANDROID_MCP_TEST_HISTORY_DIR: saved.dir,
      ANDROID_MCP_TEST_HISTORY_KEEP: saved.keep,
      ANDROID_MCP_TEST_EXCLUDE_IDS: saved.exclude,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry registers three diagnostics tools with honest risk classes and contracts", () => {
  const expected = {
    android_test_failure_analyze: "read-only",
    android_flaky_test_history: "local-write",
    android_test_failure_bundle: "local-write",
  };
  for (const [name, risk] of Object.entries(expected)) {
    const entry = TOOL_REGISTRY.find((tool) => tool.name === name);
    assert.ok(entry, `${name} is registered`);
    assert.equal(entry.risk, risk);
    assert.ok(entry.tests.includes("test/test-diagnostics.test.mjs"));
    assert.ok(entry.description.length >= 20);
    assert.equal(typeof ToolSchemas[name.replace(/^android_/, "").replace(/_([a-z])/g, (_, c) => c.toUpperCase())], "object");
  }
  const analyze = TOOL_REGISTRY.find((t) => t.name === "android_test_failure_analyze");
  assert.ok(!analyze.sideEffects.includes("host-write"));
  const bundle = TOOL_REGISTRY.find((t) => t.name === "android_test_failure_bundle");
  assert.ok(bundle.sideEffects.includes("host-write"));
});
