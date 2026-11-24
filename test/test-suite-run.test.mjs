// ISSUE-32: unified test-suite runner: discovery, per-suite execution, failure
// triage, artifact scanning, exit-code preservation and skipped-with-reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTestSuiteRun, runSuite } from "../dist/testSuiteRunner.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.NotesTest" tests="2" failures="1">
  <testcase name="savesNote" classname="com.example.NotesTest" time="0.12"/>
  <testcase name="duplicateSave" classname="com.example.NotesTest" time="0.31">
    <failure message="expected: &lt;1&gt; but was: &lt;2&gt;" type="junit.framework.AssertionFailedError">java.lang.AssertionError: expected: &lt;1&gt; but was: &lt;2&gt;
  at com.example.NotesTest.duplicateSave(NotesTest.kt:42)</failure>
  </testcase>
</testsuite>`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "od-test-suite-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(target.slice(0, target.lastIndexOf("/")) || root, { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function tree(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [e.name],
    );
  return walk(root).sort();
}

function fakeRunner(impl) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return impl(cmd, args, opts);
  };
  return { runner, calls };
}

const UNIT_FIXTURE = {
  "settings.gradle.kts": 'rootProject.name = "app"\ninclude(":app")\n',
  "app/build.gradle.kts": `plugins { id("com.android.application") }
android { compileSdk = 35 }
dependencies { testImplementation("junit:junit:4.13.2") }
`,
  "app/src/test/java/com/demo/MathTest.kt": "class MathTest\n",
  "app/src/main/java/com/demo/Math.kt": "class Math\n",
};

test("unit suite is discovered and executed via gradle testDebugUnitTest", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const report = await runSuite({ projectPath: root }, runner);
    assert.equal(report.status, "ok");
    assert.equal(report.suites.length, 1);
    assert.equal(report.suites[0].name, "unit");
    assert.equal(report.suites[0].status, "ran");
    assert.equal(report.suites[0].exitCode, 0);
    // ISSUE-146: on Windows the resolved invocation is `cmd.exe /d /s /c "<argv>"`.
    const cmdline = [calls[0].cmd, ...calls[0].args].join(" ");
    assert.match(cmdline, /gradle.*:app:testDebugUnitTest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failing suite reports exit codes, failure summary with test id and stack", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const { runner } = fakeRunner(() => {
      // Emit fresh XML at run time, like Gradle would.
      const dir = join(root, "app", "build", "test-results", "testDebugUnitTest");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "results.xml"), XML);
      return { code: 1, stdout: "", stderr: "test failed" };
    });
    const report = await runSuite({ projectPath: root }, runner);
    assert.equal(report.suites[0].status, "ran");
    assert.equal(report.suites[0].exitCode, 1);
    assert.equal(report.suites[0].passed, 1);
    assert.equal(report.suites[0].failed, 1);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
    const summary = report.suites[0].failureSummary[0];
    assert.equal(summary.testId, "com.example.NotesTest.duplicateSave");
    assert.ok(summary.stackLines.some((line) => line.includes("NotesTest.kt:42")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-seeded XML is not counted as a fresh result", async () => {
  const root = fixture({
    ...UNIT_FIXTURE,
    "app/build/test-results/testDebugUnitTest/results.xml": XML,
  });
  try {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const report = await runSuite({ projectPath: root }, runner);
    assert.equal(report.passed, 0, "stale XML must not be reported as fresh evidence");
    assert.equal(report.failed, 0);
    assert.deepEqual(report.suites[0].artifactXmls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-module projects run every module's unit suite", async () => {
  const root = fixture({
    "settings.gradle.kts": 'rootProject.name = "multi"\ninclude(":app")\ninclude(":lib")\n',
    "app/build.gradle.kts": `plugins { id("com.android.application") }\ndependencies { testImplementation("junit:junit:4.13.2") }\n`,
    "lib/build.gradle.kts": `plugins { id("java-library") }\ndependencies { testImplementation("junit:junit:4.13.2") }\n`,
    "app/src/test/java/com/demo/AppTest.kt": "class AppTest\n",
    "lib/src/test/java/com/demo/LibTest.kt": "class LibTest\n",
  });
  try {
    const { runner, calls } = fakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const report = await runSuite({ projectPath: root }, runner);
    assert.equal(report.suites.length, 2, "one unit suite per module");
    const commands = calls.map((c) => c.args.join(" "));
    assert.ok(commands.some((c) => c.includes(":app:testDebugUnitTest")));
    assert.ok(commands.some((c) => c.includes(":lib:testDebugUnitTest")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("continueOnFailure=false promotes failures to status=failed; default keeps partial", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const partial = await runSuite({ projectPath: root }, fakeRunner(() => ({ code: 1 })).runner);
    assert.equal(partial.status, "partial");
    const strict = await runSuite({ projectPath: root, continueOnFailure: false }, fakeRunner(() => ({ code: 1 })).runner);
    assert.equal(strict.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing suites are reported as skipped with a reason; nothing is invented", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root, suite: "maestro" }, runner);
    assert.equal(report.suites.length, 1);
    assert.equal(report.suites[0].name, "maestro");
    assert.equal(report.suites[0].status, "skipped");
    assert.ok(report.suites[0].reason, "reason present");
    assert.equal(report.status, "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maestro suite is discovered from flows and invoked via `maestro test <flows>`", async () => {
  const root = fixture({
    ...UNIT_FIXTURE,
    "maestro/smoke.yaml": 'appId: com.example.starter\n- launchApp\n',
  });
  try {
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root, suite: "maestro" }, runner);
    assert.equal(report.status, "ok");
    assert.equal(report.suites[0].name, "maestro");
    assert.match(calls[0].cmd, /maestro/i);
    assert.ok(calls[0].args.slice(0, 2).join(" ").includes("test"));
    assert.ok(calls[0].args.some((a) => a.includes("smoke.yaml")), "flow path passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("'ui' is an alias of 'instrumented' when a module has src/androidTest", async () => {
  const root = fixture({
    ...UNIT_FIXTURE,
    "app/build.gradle.kts": `plugins { id("com.android.application") }\ndependencies { androidTestImplementation("androidx.test.ext:junit:1.1.1") }\n`,
    "app/src/androidTest/java/com/demo/UiTest.kt": "class UiTest\n",
  });
  try {
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root, suite: "ui" }, runner);
    assert.ok(report.suites.some((s) => s.name === "instrumented"), `suites: ${report.suites.map((s) => s.name)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark is reported as skipped with a reason (not implemented)", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root, suite: "benchmark" }, runner);
    assert.equal(report.status, "skipped");
    assert.equal(report.suites[0].status, "skipped");
    assert.match(report.suites[0].reason, /not implemented/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline flag and gradleArgs are appended to gradle commands", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    await runSuite({ projectPath: root, offline: true, gradleArgs: ["--no-daemon"] }, runner);
    const cmdline = [calls[0].cmd, ...calls[0].args].join(" ");
    assert.match(cmdline, /gradle.*:app:testDebugUnitTest/);
    assert.match(cmdline, /--offline/, "offline appended");
    assert.match(cmdline, /--no-daemon/, "extra gradle args appended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module filter restricts execution to the selected module", async () => {
  const root = fixture({
    ...UNIT_FIXTURE,
    "settings.gradle.kts": 'rootProject.name = "app"\ninclude(":app", ":lib")\n',
    "lib/build.gradle.kts": 'plugins { id("com.android.library") }\n',
  });
  try {
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root, module: ":app" }, runner);
    assert.ok(report.suites.length > 0);
    for (const suite of report.suites) assert.equal(suite.name, "unit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner is read-only; render contains status line", async () => {
  const root = fixture(UNIT_FIXTURE);
  try {
    const before = tree(root);
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const report = await runSuite({ projectPath: root }, runner);
    assert.deepEqual(tree(root), before);
    assert.match(renderTestSuiteRun(report), /^status=/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry registers android_test_suite_run as an expert destructive runner tool", () => {
  const entry = TOOL_REGISTRY.find((t) => t.name === "android_test_suite_run");
  assert.ok(entry, "android_test_suite_run is registered");
  assert.equal(entry.risk, "destructive");
  assert.equal(entry.approval, "expert");
  assert.equal(entry.unattended, false);
  assert.ok(entry.tests.includes("test/test-suite-run.test.mjs"));
  assert.ok(entry.paths.some((p) => p.field === "projectPath"));
  const schema = ToolSchemas.testSuiteRun;
  assert.ok(schema.safeParse({ projectPath: "/tmp/x" }).success);
  assert.ok(!schema.safeParse({}).success, "projectPath required");
  assert.ok(schema.safeParse({ projectPath: "/tmp/x", suite: "ui" }).success);
  assert.ok(!schema.safeParse({ projectPath: "/tmp/x", suite: "benchmark", continueOnFailure: "yes" }).success);
  assert.ok(!schema.safeParse({ projectPath: "/tmp/x", timeoutMs: -1 }).success);
});
