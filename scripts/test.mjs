#!/usr/bin/env node
// ISSUE-18: run the repository test suite without npm scripts (which invoke
// npm.ps1 and fail under a restricted PowerShell execution policy).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const testScript = pkg.scripts?.test ?? "";
const match = testScript.match(/^node --test\s+(.+)$/);
if (!match) {
  console.error(`scripts/test.mjs: unsupported package.json test script: ${testScript}`);
  process.exit(2);
}
const files = match[1].split(/\s+/).filter(Boolean);

if (process.argv.includes("--list")) {
  console.log(files.join("\n"));
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
