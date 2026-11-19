// ISSUE-95: deterministic quality-policy checks. These tests exercise the
// public checker seams, not private helpers: source text in, located findings
// out. The repository assertions prove the checked-in policy and baseline stay
// internally consistent.
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

import { DEFAULT_THRESHOLDS, compareToBaseline, scanSource } from "../scripts/check-complexity.mjs";
import { scanSuppressionsSource } from "../scripts/check-suppressions.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUALITY_FIXTURE = (name) => join(REPO, "test", "fixtures", "quality", name);

function functionWithIfs(count) {
  const body = Array.from({ length: count }, (_, i) => `  if (x > ${i}) return ${i};`).join("\n");
  return `function busy(x) {\n${body}\n  return -1;\n}\n`;
}

test("a function over the cyclomatic budget fails with its location", () => {
  const violations = scanSource("src/busy.ts", functionWithIfs(12));
  const found = violations.find((v) => v.metric === "cyclomatic");
  assert.ok(found, "expected a cyclomatic violation");
  assert.equal(found.value, 13);
  assert.equal(found.limit, DEFAULT_THRESHOLDS.cyclomatic);
  assert.equal(found.line, 1);
  assert.equal(found.function, "busy");
});

test("a function at the cyclomatic budget passes", () => {
  const violations = scanSource("src/ok.ts", functionWithIfs(11));
  assert.equal(
    violations.some((v) => v.metric === "cyclomatic"),
    false,
  );
});

test("nesting over four levels fails and four passes", () => {
  const nested = (levels) => {
    let body = "  work();\n";
    for (let i = 0; i < levels; i += 1) {
      body = `  if (x) {\n${body.replace(/^/gm, "  ")}  }\n`;
    }
    return `function deep(x) {\n${body}}\n`;
  };
  assert.equal(
    scanSource("src/deep.ts", nested(4)).some((v) => v.metric === "nesting"),
    false,
  );
  const found = scanSource("src/deep.ts", nested(5)).find((v) => v.metric === "nesting");
  assert.ok(found);
  assert.equal(found.value, 5);
  assert.equal(found.limit, DEFAULT_THRESHOLDS.nesting);
});

test("function length over eighty lines fails and eighty passes", () => {
  const lines = (count) => {
    const filler = Array.from({ length: count - 2 }, (_, i) => `  x += ${i};`).join("\n");
    return `function longEntry() {\n${filler}\n}\n`;
  };
  assert.equal(
    scanSource("src/long.ts", lines(80)).some((v) => v.metric === "lines"),
    false,
  );
  const found = scanSource("src/long.ts", lines(81)).find((v) => v.metric === "lines");
  assert.ok(found);
  assert.equal(found.value, 81);
  assert.equal(found.limit, DEFAULT_THRESHOLDS.lines);
});

test("the baseline permits existing debt but rejects new or increased violations", () => {
  const scan = scanSource("src/busy.ts", functionWithIfs(12));
  const baseline = { "src/busy.ts::busy": { cyclomatic: 13, nesting: 1, lines: 16 } };
  assert.deepEqual(compareToBaseline(scan, baseline).violations, []);

  const grew = scanSource("src/busy.ts", functionWithIfs(13));
  const increased = compareToBaseline(grew, baseline).violations;
  assert.ok(increased.some((v) => v.metric === "cyclomatic" && v.value === 14));

  const other = scanSource("src/other.ts", functionWithIfs(12));
  const added = compareToBaseline(other, baseline).violations;
  assert.ok(added.some((v) => v.file === "src/other.ts"));
});

test("blanket file-level eslint disables are rejected", () => {
  const violations = scanSuppressionsSource("src/bad.ts", "/* eslint-disable */\nconst x = 1;\n");
  assert.ok(violations.some((v) => v.rule === "eslint-disable-file-blanket"));
});

test("a narrow eslint disable with a reason is allowed", () => {
  const text =
    "/* eslint-disable no-control-regex -- control characters are the input */\nconst x = 1;\n";
  assert.deepEqual(scanSuppressionsSource("src/ok.ts", text), []);
});

test("line-local suppression requires an explanation", () => {
  const bad = "// eslint-disable-next-line no-explicit-any\nconst x: any = 1;\n";
  assert.ok(scanSuppressionsSource("src/bad.ts", bad).some((v) => v.rule === "suppression-reason"));
  const ok =
    "// eslint-disable-next-line no-explicit-any -- SDK boundary lacks a type\nconst x = 1;\n";
  assert.deepEqual(scanSuppressionsSource("src/ok.ts", ok), []);
});

test("blanket type suppression is rejected and explained type suppression passes", () => {
  const noCheck = "// @ts-nocheck\nconst x = 1;\n";
  assert.ok(scanSuppressionsSource("src/bad.ts", noCheck).some((v) => v.rule === "ts-nocheck"));
  const expected = "// @ts-expect-error -- upstream declaration is wrong\nconst x = 1;\n";
  assert.deepEqual(scanSuppressionsSource("src/ok.ts", expected), []);
  const bare = "// @ts-ignore\nconst x = 1;\n";
  assert.ok(
    scanSuppressionsSource("src/bad.ts", bare).some((v) => v.rule === "suppression-reason"),
  );
});

test("the real ESLint config rejects explicit any, floating/misused promises and assertions", async () => {
  const eslint = new ESLint({ cwd: REPO });
  const [result] = await eslint.lintFiles([QUALITY_FIXTURE("rejected.ts")]);
  const rules = new Set(result.messages.map((message) => message.ruleId));
  for (const rule of [
    "@typescript-eslint/no-explicit-any",
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-misused-promises",
    "@typescript-eslint/no-unnecessary-type-assertion",
  ]) {
    assert.ok(rules.has(rule), `expected ${rule}; saw ${[...rules].join(", ")}`);
  }
});

test("the real ESLint config accepts unknown narrowing and awaited promises", async () => {
  const eslint = new ESLint({ cwd: REPO });
  const [result] = await eslint.lintFiles([QUALITY_FIXTURE("allowed.ts")]);
  assert.deepEqual(
    result.messages.map((message) => `${message.ruleId}: ${message.message}`),
    [],
  );
});
