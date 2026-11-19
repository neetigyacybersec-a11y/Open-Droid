#!/usr/bin/env node
// ISSUE-95: suppressions are narrow, explained and visible.
//
// A suppression may silence one rule on one line/block when the reason follows
// `--`. Blanket file-level disables and file-wide @ts-nocheck are rejected.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function hasReason(text) {
  const match = text.match(/--\s*(.+?)\s*$/);
  return Boolean(match && match[1].trim().length > 0);
}

/** Inspect one file's text and return policy violations with line locations. */
export function scanSuppressionsSource(file, text) {
  const violations = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    const add = (rule, message) => violations.push({ file, line: lineNumber, rule, message });

    // Only a leading comment is a real directive. This also keeps fixture
    // strings and documentation examples from being mistaken for suppressions.
    const comment = line.match(/^\s*(?:\/\/|\/\*)\s*(.*?)(?:\*\/)?\s*$/)?.[1];
    if (!comment) return;

    const disable = comment.match(/^eslint-disable(?!-next-line|-line)/);
    if (disable) {
      const rules = comment
        .replace(/^eslint-disable/, "")
        .replace(/--.*$/, "")
        .trim();
      if (!rules)
        add("eslint-disable-file-blanket", "file-level eslint-disable needs explicit rules");
      else if (!hasReason(comment)) add("suppression-reason", "eslint-disable needs a -- reason");
    }

    const lineDisable = comment.match(/^eslint-disable-(?:next-line|line)/);
    if (lineDisable) {
      const rules = comment
        .replace(/^eslint-disable-(?:next-line|line)/, "")
        .replace(/--.*$/, "")
        .trim();
      if (!rules) add("eslint-disable-line-blanket", "line suppression needs explicit rules");
      else if (!hasReason(comment)) add("suppression-reason", "eslint-disable needs a -- reason");
    }

    if (/^@ts-nocheck\b/.test(comment)) {
      add("ts-nocheck", "@ts-nocheck disables checking for the whole file");
    }
    if (/^@ts-(?:ignore|expect-error)\b/.test(comment) && !hasReason(comment)) {
      add("suppression-reason", "@ts-ignore/@ts-expect-error needs a -- reason");
    }
    if (/^prettier-ignore\b/.test(comment) && !hasReason(comment)) {
      add("suppression-reason", "prettier-ignore needs a -- reason");
    }
  });
  return violations;
}

function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(?:ts|mjs|js)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of ["src", "test", "scripts"]) walk(join(root, dir));
  return files.sort();
}

export function scanSuppressions(root = ROOT) {
  return sourceFiles(root).flatMap((full) => {
    const file = relative(root, full).split(sep).join("/");
    return scanSuppressionsSource(file, readFileSync(full, "utf8"));
  });
}

function main() {
  const violations = scanSuppressions(ROOT);
  if (violations.length === 0) {
    process.stdout.write("suppression policy OK: every suppression is narrow and explained\n");
    return;
  }
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.rule}: ${violation.message}\n`,
    );
  }
  process.stderr.write(`suppression policy FAILED: ${violations.length} violation(s)\n`);
  process.exitCode = 1;
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
