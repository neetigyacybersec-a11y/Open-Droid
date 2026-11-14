#!/usr/bin/env node
// ISSUE-18: build or typecheck without npm scripts (restricted PowerShell).
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const noEmit = process.argv.includes("--noEmit");
const args = [tsc, ...(noEmit ? ["--noEmit"] : []), "-p", "tsconfig.json"];

if (process.argv.includes("--print-command")) {
  console.log(JSON.stringify([process.execPath, ...args]));
  process.exit(0);
}

const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
process.exit(result.status ?? 1);
