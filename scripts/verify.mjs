#!/usr/bin/env node
// ISSUE-160: the single authoritative MCP verification contract. Both CI
// platforms call this directly so no npm shim or PowerShell policy is needed.
// Build once, then run every mandatory gate; failures stop the sequence.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const steps = [
  ["typecheck", NODE, [join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"]],
  ["lint", NODE, [join(ROOT, "scripts/lint.mjs")]],
  ["format", NODE, [join(ROOT, "node_modules/prettier/bin/prettier.cjs"), "--check", "src"]],
  ["guardrails", NODE, [join(ROOT, "scripts/check-guardrails.mjs")]],
  ["build", NODE, [join(ROOT, "scripts/build.mjs")]],
  ["tests", NODE, [join(ROOT, "scripts/test.mjs")]],
  ["architecture", NODE, [join(ROOT, "scripts/check-architecture.mjs")]],
  ["quality", NODE, [join(ROOT, "scripts/quality.mjs")]],
  ["catalogue", NODE, [join(ROOT, "scripts/tool-catalogue.mjs"), "--check"]],
  ["readme", "bash", [join(ROOT, "scripts/check-readme.sh")]],
  ["lifecycle", NODE, [join(ROOT, "scripts/lifecycle-matrix.mjs"), "--check"]],
  ["hygiene", "bash", [join(ROOT, "scripts/repo-hygiene.sh")]],
];

for (const [name, command, args] of steps) {
  console.log(`[verify] ${name}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[verify] FAILED: ${name} (exit ${result.status ?? 1})`);
    process.exit(result.status ?? 1);
  }
}
console.log("[verify] all mandatory checks passed");
