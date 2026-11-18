#!/usr/bin/env node
// ISSUE-96: architecture contract for dangerous runtime capabilities.
//
// Process execution is a low-level capability. Tool handlers describe what
// should happen and call approved services; they must not import
// node:child_process, spawn detached children or compose raw host commands.
// This checker is intentionally small and file-based. Semantic safety (argv
// boundaries, remote quoting, process identity) is covered by handler tests.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_PROCESS_FILES = Object.freeze([
  "src/services/process-runner.ts",
  "src/services/managed-process.ts",
]);

const CHILD_PROCESS_IMPORT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?child_process["']/;
const RAW_EXEC = /(?<![.\w])exec(?:Sync)?\s*\(/;
const RAW_SPAWN = /(?<![.\w])spawn\s*\(/;
const RAW_EXEC_FILE = /(?<![.\w])execFile\s*\(/;

function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(root, "src"));
  return files.sort();
}

/**
 * Scan a source tree for direct low-level process access outside the approved
 * services. Returns every violation instead of stopping at the first one so a
 * refactor can be planned from one report.
 */
export function scanArchitecture(root) {
  const violations = [];
  const approved = [...APPROVED_PROCESS_FILES];
  const approvedSet = new Set(approved);

  for (const full of sourceFiles(root)) {
    const file = relative(root, full).split(sep).join("/");
    const text = readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    const approve = approvedSet.has(file);

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (!approve && CHILD_PROCESS_IMPORT.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          rule: "child-process-import",
          message: "node:child_process may only be imported by an approved process service",
        });
      }
      if (RAW_EXEC.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          rule: "exec-call",
          message: "exec/execSync is forbidden; use an argv-based approved service",
        });
      }
      if (!approve && RAW_SPAWN.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          rule: "spawn-call",
          message: "spawn may only be called by the managed-process service",
        });
      }
      if (!approve && RAW_EXEC_FILE.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          rule: "exec-file-call",
          message: "execFile may only be called by the process-runner service",
        });
      }
    });
  }

  return { ok: violations.length === 0, approved, violations };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = scanArchitecture(root);
  if (result.ok) {
    process.stdout.write(
      `architecture OK: ${result.approved.length} approved process services, no unapproved access\n`,
    );
    return;
  }
  for (const violation of result.violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.rule}: ${violation.message}\n`,
    );
  }
  process.stderr.write(`architecture FAILED: ${result.violations.length} violation(s)\n`);
  process.exitCode = 1;
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
