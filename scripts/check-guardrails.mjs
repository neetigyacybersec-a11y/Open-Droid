#!/usr/bin/env node
// Deterministic guardrail checks for test and CI integrity (ISSUE-97).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const failures = [];

/** Test filenames in the package.json script use POSIX separators on all hosts. */
export function testFileName(file) {
  return file.replace(/\\/g, "/").split("/").pop();
}

function fail(message) {
  failures.push(message);
}

const testFiles = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => join(root, "test", name));

for (const file of testFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const rel = relative(root, file).split(sep).join("/");
  lines.forEach((line, index) => {
    if (/\.(only)\b/.test(line)) {
      fail(`${rel}:${index + 1}: focused test selector (.only) is not allowed`);
    }
    if (/\.(todo)\b/.test(line)) {
      fail(`${rel}:${index + 1}: test.todo is not allowed in committed tests`);
    }
    if (/\.skip\b/.test(line) || /\bskip\s*\(/.test(line)) {
      // Accept a platform condition on the skip line or in its enclosing block
      // (up to the three preceding lines), not anywhere in the whole file.
      const context = `${lines.slice(Math.max(0, index - 3), index + 1).join("\n")}`;
      const platformConditional =
        line.includes("process.platform") ||
        line.includes("win32") ||
        /process\.platform|win32/.test(context);
      if (!platformConditional) {
        fail(`${rel}:${index + 1}: test skip requires a documented platform condition`);
      }
    }
  });
}

const ciPath = join(root, ".github", "workflows", "ci.yml");
const ci = readFileSync(ciPath, "utf8");
if (/continue-on-error:\s*true/i.test(ci)) {
  fail(".github/workflows/ci.yml: continue-on-error: true is not allowed");
}
if (/--if-present/.test(ci)) {
  fail(".github/workflows/ci.yml: --if-present is not allowed for mandatory tests");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const testScript = pkg.scripts?.test ?? "";
if (testScript.includes("--if-present")) {
  fail("package.json: test script must not use --if-present");
}
const listedTests = new Set(
  (testScript.match(/test\/[A-Za-z0-9._-]+\.mjs/g) ?? []).map((entry) =>
    entry.replace(/^test\//, ""),
  ),
);
for (const file of testFiles) {
  const name = testFileName(file);
  if (!listedTests.has(name)) {
    fail(`package.json test script omits required test file: ${name}`);
  }
}

if (failures.length > 0) {
  console.error("[guardrails] FAILED");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`[guardrails] OK (${testFiles.length} test files checked)`);
