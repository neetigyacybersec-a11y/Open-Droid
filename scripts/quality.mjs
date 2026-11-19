#!/usr/bin/env node
// ISSUE-95: the checked-in quality gates, invoked the same way on every shell.
// Lint itself stays in scripts/lint.mjs so the type-aware pass runs once.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS = ["check-complexity.mjs", "check-suppressions.mjs"];

for (const check of CHECKS) {
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", check)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
