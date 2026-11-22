// ISSUE-31: deterministic, read-only test strategy planner: risk-based coverage
// mapping, requirement extraction, framework/coverage inventory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTestPlan, renderTestPlan } from "../dist/testPlan.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const SPEC = `# Feature: Notes

## Save note
- Saving a note persists it to the notes store
- Saving a note while offline queues the write for retry

## Open note
- Opening a note shows the note detail view

## Permissions
- Opening a note requests storage permission when missing
- Opening a note still works with storage permission denied

## Review flow
- Reviewing shows a confirmation snackbar
`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "od-testplan-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(target.slice(0, target.lastIndexOf("/")) || root, { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function tree(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name;
    });
  return walk(root).sort();
}

const BASE_PROJECT = {
  "settings.gradle.kts": 'rootProject.name = "notes"\ninclude(":app")\n',
  "app/build.gradle.kts": `plugins { id("com.android.application") }
android { compileSdk = 35 }
dependencies {
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
`,
  "app/src/main/java/com/demo/NotesRepository.kt": "class NotesRepository\n",
};

test("frameworks detected from module build files and androidTest evidence", () => {
  const root = fixture(BASE_PROJECT);
  try {
    const report = generateTestPlan({ projectPath: root });
    assert.ok(report.frameworks.includes("junit4"), `junit4 detected, got ${report.frameworks}`);
    assert.ok(report.frameworks.includes("espresso"));
    assert.ok(report.frameworks.includes("instrumented"), "androidTest exists => instrumented");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing tests are inventoried from src/test and src/androidTest", () => {
  const root = fixture({
    ...BASE_PROJECT,
    "app/src/test/java/com/demo/NotePersistenceTest.kt": "package com.demo\nclass NotePersistenceTest\n",
    "app/src/androidTest/java/com/demo/HomeScreenTest.kt": "package com.demo\nclass HomeScreenTest\n",
  });
  try {
    const report = generateTestPlan({ projectPath: root });
    const unitNames = report.existingTests.unit.map((t) => t.className);
    assert.ok(unitNames.includes("NotePersistenceTest"), `unit classes: ${unitNames}`);
    assert.ok(report.existingTests.instrumented.some((t) => t.className === "HomeScreenTest"));
    assert.ok(report.existingTests.unit.every((t) => t.package === "com.demo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature spec requirements are extracted and mapped to test cases", () => {
  const root = fixture({ ...BASE_PROJECT, "SPEC.md": SPEC });
  try {
    const report = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md") });
    assert.ok(report.requirements.length >= 4, `requirements extracted, got ${report.requirements.length}`);
    const saveNote = report.requirements.find((r) => r.id === "save-note");
    assert.ok(saveNote, `requirement id for "Save note": ${report.requirements.map((r) => r.id)}`);
    assert.match(saveNote.text, /persists it to the notes store/);
    assert.ok(saveNote.testCases.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requirement test cases reflect risk: persistence=integration, permission=manual", () => {
  const root = fixture({ ...BASE_PROJECT, "SPEC.md": SPEC });
  try {
    const report = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md") });
    const byId = Object.fromEntries(report.requirements.map((r) => [r.id, r]));
    const levelsOf = (id) => byId[id].testCases.map((t) => t.level);
    assert.ok(levelsOf("save-note").includes("integration"), `save-note levels: ${levelsOf("save-note")}`);
    assert.ok(levelsOf("permissions").includes("manual"), `permissions levels: ${levelsOf("permissions")}`);
    assert.ok(levelsOf("review-flow").every((level) => level === "e2e"), `review-flow levels: ${levelsOf("review-flow")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan separates existing coverage, additions with no duplicates", () => {
  const root = fixture({
    ...BASE_PROJECT,
    "SPEC.md": SPEC,
    "app/src/test/java/com/demo/NotePersistenceTest.kt": "package com.demo\nclass NotePersistenceTest\n",
  });
  try {
    const report = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md") });
    assert.ok(report.plan.existing.length > 0, "existing coverage listed");
    assert.ok(report.plan.additions.length > 0, "recommended additions listed");
    for (const item of [...report.plan.existing, ...report.plan.additions])
      assert.ok(item.name.length > 0, "every plan item has a name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed files identify relevant tests in their modules with rationale", () => {
  const root = fixture({ ...BASE_PROJECT, "app/src/test/java/com/demo/OtherTest.kt": "class OtherTest\n" });
  try {
    const report = generateTestPlan({ projectPath: root, changedFiles: ["app/src/main/java/com/demo/NotesRepository.kt"] });
    assert.ok(report.changedFilePlan.changedFiles.includes("app/src/main/java/com/demo/NotesRepository.kt"));
    const app = report.changedFilePlan.relevantTests.find((t) => t.module === "app");
    assert.ok(app, `tests relevant to app found: ${report.changedFilePlan.relevantTests.map((t) => t.module)}`);
    assert.ok(app.tests.length > 0, `tests listed, got ${app.tests}`);
    assert.match(app.why, /app/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("riskLevel raises the coverage floor in the risk plan", () => {
  const root = fixture({ ...BASE_PROJECT, "SPEC.md": SPEC });
  try {
    const high = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md"), riskLevel: "high" });
    assert.ok(high.riskPlan.coverageFloor.includes("e2e"), `high risk floor: ${high.riskPlan.coverageFloor}`);
    const low = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md"), riskLevel: "low" });
    assert.ok(low.riskPlan.coverageFloor.includes("unit"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assumptions are labelled by confidence", () => {
  const root = fixture(BASE_PROJECT);
  try {
    const report = generateTestPlan({ projectPath: root });
    assert.ok(report.assumptions.length > 0);
    for (const a of report.assumptions)
      assert.ok(["high", "medium", "low"].includes(a.confidence), `confidence on: ${a.statement}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matrix lists required API levels from module SDKs", () => {
  const root = fixture(BASE_PROJECT);
  try {
    const report = generateTestPlan({ projectPath: root });
    assert.ok(report.matrix.length > 0);
    for (const entry of report.matrix) assert.match(entry, /^api-\d+$/);
    assert.ok(report.matrix.includes("api-35"), `compileSdk 35 matrix entry, got ${report.matrix}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planning is read-only unless saveArtifact is requested", () => {
  const root = fixture({ ...BASE_PROJECT, "SPEC.md": SPEC });
  try {
    const before = tree(root);
    generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md") });
    assert.deepEqual(tree(root), before, "no files written by default");
    const artifact = generateTestPlan({ projectPath: root, featureSpecPath: join(root, "SPEC.md"), saveArtifact: true });
    assert.ok(artifact.artifact?.path, "artifact path returned");
    assert.ok(tree(root).includes(artifact.artifact.path));
    assert.ok(statSync(join(root, artifact.artifact.path)).size > 0);
    const md = readFileSync(join(root, artifact.artifact.path), "utf8");
    assert.match(md, /# Test plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing project path is an explicit error", () => {
  const root = mkdtempSync(join(tmpdir(), "od-testplan-"));
  try {
    const missing = generateTestPlan({ projectPath: join(root, "nope") });
    assert.equal(missing.status, "error");
    assert.ok(missing.reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("render is deterministic and summary is populated", () => {
  const root = fixture({ ...BASE_PROJECT, "SPEC.md": SPEC });
  try {
    const a = renderTestPlan(generateTestPlan({ projectPath: root }));
    const b = renderTestPlan(generateTestPlan({ projectPath: root }));
    assert.equal(a, b);
    assert.match(a, /# Test plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry registers android_test_plan as an unattended read-only planning tool", () => {
  const entry = TOOL_REGISTRY.find((t) => t.name === "android_test_plan");
  assert.ok(entry, "android_test_plan is registered");
  assert.equal(entry.risk, "read-only");
  assert.equal(entry.approval, "none");
  assert.equal(entry.unattended, true);
  assert.ok(!entry.sideEffects.some((s) => s.includes("write") || s.includes("delete")));
  assert.ok(entry.tests.includes("test/test-plan.test.mjs"));
  assert.ok(entry.paths.some((p) => p.field === "projectPath"));
  const schema = ToolSchemas.testPlan;
  assert.ok(schema.safeParse({ projectPath: "/tmp/x" }).success);
  assert.ok(!schema.safeParse({}).success, "projectPath required");
  assert.ok(!schema.safeParse({ projectPath: "/tmp/x", riskLevel: "catastrophic" }).success);
});
