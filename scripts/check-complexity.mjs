#!/usr/bin/env node
// ISSUE-95: measured complexity budgets with a checked-in ratchet.
//
// Limits apply to every function in src/. Existing debt is recorded in
// scripts/quality-baseline.json; a new function or an increase over its
// recorded metric fails CI. Reduce a metric and run --update-baseline to lock
// the improvement in.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const DEFAULT_THRESHOLDS = Object.freeze({
  cyclomatic: 12,
  nesting: 4,
  lines: 80,
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "quality-baseline.json");

const CONTROL_FLOW = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause,
]);

const DECISION = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);

function isFunction(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    if (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) return parent.name.text;
  }
  // Anonymous callbacks are qualified by the nearest named enclosing function.
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (isFunction(ancestor)) {
      const owner = functionName(ancestor);
      if (!owner.startsWith("anonymous")) return `${owner}.anonymous`;
      break;
    }
  }
  return "anonymous";
}

function measure(node, sourceFile) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  let cyclomatic = 1;
  let maxNesting = 0;

  const walk = (child, depth) => {
    if (child !== node && isFunction(child)) return;
    const kind = child.kind;
    let nextDepth = depth;
    if (CONTROL_FLOW.has(kind)) {
      nextDepth += 1;
      if (nextDepth > maxNesting) maxNesting = nextDepth;
    }
    if (
      DECISION.has(kind) ||
      (ts.isBinaryExpression(child) &&
        (child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          child.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      cyclomatic += 1;
    }
    ts.forEachChild(child, (grandchild) => walk(grandchild, nextDepth));
  };
  walk(node, 0);

  return { cyclomatic, nesting: maxNesting, lines: end - start + 1 };
}

/**
 * Analyze one source text and return every over-budget function with a stable
 * `${file}::${name}` key. Duplicate names receive an occurrence suffix.
 */
export function scanSource(file, text, thresholds = DEFAULT_THRESHOLDS) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const functions = [];
  const visit = (node) => {
    if (isFunction(node)) functions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const seen = new Map();
  const violations = [];
  for (const node of functions) {
    const base = functionName(node);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const key = `${file}::${base}${occurrence > 1 ? `#${occurrence}` : ""}`;
    const metrics = measure(node, sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    for (const metric of ["cyclomatic", "nesting", "lines"]) {
      if (metrics[metric] > thresholds[metric]) {
        violations.push({
          key,
          file,
          function: base,
          line,
          metric,
          value: metrics[metric],
          limit: thresholds[metric],
        });
      }
    }
  }
  return violations;
}

/** Split violations into allowed baseline debt and new/increased debt. */
export function compareToBaseline(violations, baseline) {
  const allowed = [];
  const rejected = [];
  for (const violation of violations) {
    const recorded = baseline[violation.key]?.[violation.metric];
    if (typeof recorded === "number" && violation.value <= recorded) allowed.push(violation);
    else rejected.push(violation);
  }
  return { ok: rejected.length === 0, allowed, violations: rejected };
}

export function toBaseline(violations) {
  const baseline = {};
  for (const violation of violations) {
    baseline[violation.key] ??= {};
    baseline[violation.key][violation.metric] = Math.max(
      baseline[violation.key][violation.metric] ?? 0,
      violation.value,
    );
  }
  return Object.fromEntries(
    Object.entries(baseline).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  walk(join(root, "src"));
  return files.sort();
}

export function scanRepository(root = ROOT, thresholds = DEFAULT_THRESHOLDS) {
  return sourceFiles(root).flatMap((full) => {
    const file = relative(root, full).split(sep).join("/");
    return scanSource(file, readFileSync(full, "utf8"), thresholds);
  });
}

function main() {
  const update = process.argv.includes("--update-baseline");
  const violations = scanRepository(ROOT);
  if (update) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(violations), null, 2)}\n`);
    process.stdout.write(`quality baseline updated: ${violations.length} recorded violation(s)\n`);
    return;
  }
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    process.stderr.write(`quality FAILED: missing ${relative(process.cwd(), BASELINE_PATH)}\n`);
    process.exitCode = 1;
    return;
  }
  const result = compareToBaseline(violations, baseline);
  if (result.ok) {
    process.stdout.write(
      `quality budget OK: ${result.allowed.length} baseline violation(s), no new or increased debt\n`,
    );
    return;
  }
  for (const violation of result.violations) {
    process.stderr.write(
      `${violation.file}:${violation.line}: ${violation.function} ${violation.metric}=` +
        `${violation.value} exceeds ${violation.limit}\n`,
    );
  }
  process.stderr.write(
    `quality FAILED: ${result.violations.length} new or increased violation(s)\n`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
