// ISSUE-96: dangerous low-level capabilities live behind approved services.
// These tests are deliberately about structure: a future handler that imports
// child_process or spawns a detached process outside the approved service must
// fail CI even if its own unit tests pass.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { scanArchitecture } from "../scripts/check-architecture.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "android-mcp-architecture-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test("the repository has no unapproved low-level process access", () => {
  const result = scanArchitecture(REPO);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.ok(result.approved.includes("src/services/process-runner.ts"));
  assert.ok(result.approved.includes("src/services/managed-process.ts"));
});

test("a fixture importing execSync outside an approved service is rejected", () => {
  const root = fixture({
    "src/handler.ts": 'import { execSync } from "node:child_process";\nexecSync("echo unsafe");\n',
  });
  try {
    const result = scanArchitecture(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.rule === "child-process-import"));
    assert.ok(result.violations.some((v) => v.file === "src/handler.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fixture spawning a child outside the managed-process service is rejected", () => {
  const root = fixture({
    "src/handler.ts":
      'import { spawn } from "node:child_process";\nconst child = spawn("adb", ["devices"]);\n',
  });
  try {
    const result = scanArchitecture(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.rule === "child-process-import"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved services are allowed to use their own primitive", () => {
  const root = fixture({
    "src/services/process-runner.ts":
      'import { execFile } from "node:child_process";\nexecFile("git", ["status"], () => {});\n',
    "src/services/managed-process.ts":
      'import { spawn } from "node:child_process";\nspawn("node", ["--version"], { stdio: "ignore" });\n',
  });
  try {
    assert.equal(scanArchitecture(root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a raw spawn hidden in a non-process service is still rejected", () => {
  const root = fixture({
    "src/services/adb-client.ts":
      'import { spawn } from "node:child_process";\nspawn("adb", ["devices"]);\n',
  });
  try {
    const result = scanArchitecture(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some((v) => v.rule === "child-process-import"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
