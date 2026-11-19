#!/usr/bin/env node
// ISSUE-95: one type-aware ESLint invocation, measured and shell-portable.
// Type-aware linting is the slow part; run it once per job instead of adding a
// second invocation elsewhere in CI.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const targets = process.argv.slice(2);
const args = [eslint, ...(targets.length > 0 ? targets : ["src"])];

const started = process.hrtime.bigint();
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
const status = result.status ?? 1;
process.stdout.write(
  `[android-mcp] eslint ${status === 0 ? "OK" : "FAILED"} in ${seconds.toFixed(1)}s\n`,
);
process.exit(status);
