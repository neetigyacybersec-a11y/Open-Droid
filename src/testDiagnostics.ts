// ISSUE-33: evidence-backed test failure diagnosis, local flaky history and
// reproducible bundles. Nothing is sent off-device: reports are read from the
// caller's workspace, history and bundles live in a server-owned local store.
// Hypotheses are labelled with confidence and unknowns are explicit so an
// agent cannot present a guess as a proven root cause.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { errorMessage } from "./util.js";

export type TestStatus = "passed" | "failed" | "skipped";
export type OutcomeStatus = "pass" | "fail" | "skip";
export type Confidence = "high" | "medium" | "low";

export interface TestCase {
  name: string;
  classname: string;
  testId: string;
  status: TestStatus;
  timeSeconds: number;
  durationMs: number;
  message: string;
  stack: string;
}

export interface Hypothesis {
  cause: string;
  confidence: Confidence;
  evidence: string[];
}

export interface FailureInput {
  reportPath: string;
  testId?: string;
  logcatPath?: string;
  gradlePath?: string;
  emulatorPath?: string;
  screenshotPath?: string;
  metadata?: Record<string, string>;
}

export type FailureStatus =
  "assertion-failure" | "crash" | "timeout" | "error" | "insufficient-evidence";

export interface FailureReport {
  status: FailureStatus;
  testId: string | null;
  source: string;
  observed: string;
  stackLines: string[];
  hypotheses: Hypothesis[];
  evidence: string[];
  unknowns: string[];
  metadata: Record<string, string>;
  nextStep: string;
  insufficientEvidence: boolean;
}

export interface OutcomeInput {
  testId: string;
  status: OutcomeStatus;
  environment?: Record<string, string>;
  at?: string;
}

export interface HistoryOptions {
  testId?: string;
  minRuns?: number;
  excludeTestIds?: string[];
}

export interface FlakyEntry {
  testId: string;
  environment: Record<string, string>;
  runs: number;
  passes: number;
  failures: number;
  evidence: string[];
}

export interface BundleInput extends FailureInput {
  metadata?: Record<string, string>;
}

export interface BundleResult {
  path: string;
  report: FailureReport;
}

const DEFAULT_HISTORY_KEEP = 1000;
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED-TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED-TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED-TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED-TOKEN]"],
  [/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g, "https://[REDACTED]@"],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "[REDACTED]"],
  [/\b[A-Za-z0-9-]+\.(?:internal|corp|lan|local)\b/gi, "[REDACTED-HOST]"],
  [/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
  [/\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
  [/\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED-HOST]"],
  [/(?:\/home\/|\/Users\/)[A-Za-z0-9._-]+(?:\/[^\s"']*)?/g, "[REDACTED-PATH]"],
  [/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\[^\s"']*)?/gi, "[REDACTED-PATH]"],
];

/** Remove tokens, internal hosts and user home paths before any text is shared. */
export function redactDiagnosticText(text: string): string {
  let safe = text ?? "";
  for (const [pattern, replacement] of REDACTIONS) safe = safe.replace(pattern, replacement);
  return safe;
}

function historyDir(): string {
  return (
    process.env.ANDROID_MCP_TEST_HISTORY_DIR?.trim() ||
    join(homedir(), ".android-mcp", "test-history")
  );
}

function historyKeep(): number {
  const raw = Number(process.env.ANDROID_MCP_TEST_HISTORY_KEEP);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_HISTORY_KEEP;
}

function excluded(testId: string, patterns: readonly string[] = []): boolean {
  const all = [
    ...patterns,
    ...(process.env.ANDROID_MCP_TEST_EXCLUDE_IDS?.split(",").map((s) => s.trim()) ?? []),
  ];
  return all.some((pattern) => {
    if (!pattern) return false;
    const exact = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${exact}$`).test(testId);
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  for (const match of tag.matchAll(pattern)) result[match[1]] = decodeEntities(match[2]);
  return result;
}

function parseCase(block: string): TestCase | null {
  const open = block.match(/<testcase\b[^>]*>/);
  if (!open) return null;
  const attrs = attributes(open[0]);
  const failure = block.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
  const skipped = /<skipped\b/.test(block);
  const status: TestStatus = failure ? "failed" : skipped ? "skipped" : "passed";
  const detail = failure ? attributes(`<x${failure[2]}>`) : {};
  const timeSeconds = Number(attrs.time ?? 0) || 0;
  const name = attrs.name ?? "";
  const classname = attrs.classname ?? "";
  return {
    name,
    classname,
    testId: classname ? `${classname}.${name}` : name,
    status,
    timeSeconds,
    durationMs: Math.round(timeSeconds * 1000),
    message: redactDiagnosticText(detail.message ?? ""),
    stack: redactDiagnosticText(decodeEntities(failure?.[3] ?? "").trim()),
  };
}

/** Parse standard JUnit XML (single suite or testsuites wrapper). */
export function parseJUnitXml(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const pattern = /<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const parsed = parseCase(match[0]);
    if (parsed) cases.push(parsed);
  }
  return cases;
}

function insufficient(input: FailureInput, reason: string): FailureReport {
  return {
    status: "insufficient-evidence",
    testId: input.testId ?? null,
    source: input.reportPath,
    observed: "",
    stackLines: [],
    hypotheses: [],
    evidence: [],
    unknowns: [`Insufficient evidence: ${reason}`],
    metadata: redactMetadata(input.metadata),
    nextStep: `Provide a readable JUnit XML report or log evidence and re-run: ${reason}`,
    insufficientEvidence: true,
  };
}

function redactMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {}))
    result[key] = redactDiagnosticText(String(value));
  return result;
}

function stackLinesOf(stack: string): string[] {
  return stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function logcatHypotheses(
  text: string,
  filename: string,
  identifiers: readonly string[] = [],
): Hypothesis[] {
  const matches = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /FATAL EXCEPTION|AndroidRuntime|ANR in|Not Responding|Exception:/i.test(line),
    );
  // Prefer lines mentioning the failing test or package when they are present;
  // keep other signature lines as lower-ranked evidence.
  matches.sort((a, b) => {
    const score = (line: string) =>
      identifiers.some((id) => id && line.toLowerCase().includes(id.toLowerCase())) ? 0 : 1;
    return score(a) - score(b);
  });
  const lines = matches
    .map((line) => `${filename}: ${redactDiagnosticText(line)}`)
    .filter(Boolean)
    .slice(0, 6);
  const findings: Hypothesis[] = [];
  if (lines.some((line) => /FATAL EXCEPTION|AndroidRuntime|Exception:/i.test(line)))
    findings.push({
      cause: "App crash recorded in logcat near the failing test",
      confidence: "medium",
      evidence: lines.filter((line) => /FATAL|AndroidRuntime|Exception:/i.test(line)),
    });
  if (lines.some((line) => /ANR in|Not Responding/i.test(line)))
    findings.push({
      cause: "Application Not Responding (ANR) recorded in logcat",
      confidence: "medium",
      evidence: lines.filter((line) => /ANR|Not Responding/i.test(line)),
    });
  return findings;
}

function nextStepFor(status: FailureStatus, report: FailureReport): string {
  if (status === "timeout")
    return "Re-run with an extended timeout and capture a thread dump; compare the recorded duration with test configuration.";
  if (status === "crash")
    return "Correlate the logcat FATAL EXCEPTION timestamp with this test, then pull the full tombstone for the crashing process.";
  if (report.hypotheses.some((h) => /ANR/i.test(h.cause)))
    return "Capture a CPU/memory trace during a re-run and check for main-thread blocking around this test.";
  return `Compare expected and actual values at ${report.stackLines[0] ?? "the first stack frame"}, then inspect the test's state setup before changing assertions.`;
}

function readOptional(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function findFailure(input: FailureInput, cases: TestCase[]): TestCase | null {
  if (input.testId) return cases.find((item) => item.testId === input.testId) ?? null;
  return cases.find((item) => item.status === "failed") ?? null;
}

function evidenceLines(
  input: FailureInput,
  target: TestCase,
  stackLines: readonly string[],
  observed: string,
): string[] {
  const reportName = basename(input.reportPath);
  const lines = [`${reportName}: ${target.testId}: ${observed}`.trim()];
  if (stackLines[0]) lines.push(`${reportName}: ${stackLines[0]}`);
  const sources: readonly (readonly [string | undefined, string])[] = [
    [input.logcatPath, readOptional(input.logcatPath)],
    [input.gradlePath, readOptional(input.gradlePath)],
    [input.emulatorPath, readOptional(input.emulatorPath)],
    [input.screenshotPath, readOptional(input.screenshotPath)],
  ];
  for (const [file, text] of sources) {
    if (file && text)
      lines.push(`${basename(file)}: ${redactDiagnosticText(text.split(/\r?\n/)[0])}`);
  }
  return lines;
}

interface Signatures {
  hypotheses: Hypothesis[];
  timedOut: boolean;
  assertion: boolean;
}

function signatures(
  input: FailureInput,
  target: TestCase,
  logcat: string,
  gradle: string,
  observed: string,
): Signatures {
  const identifiers = [target.classname, input.metadata?.packageName ?? ""].filter(Boolean);
  const hypotheses = logcatHypotheses(
    logcat,
    input.logcatPath ? basename(input.logcatPath) : "logcat",
    identifiers,
  );
  const timedOut = /timed?\s*out|timeout/i.test(`${target.message} ${target.stack} ${gradle}`);
  const assertion = /assert|expected|but was/i.test(`${target.message} ${target.stack}`);
  const source = `${basename(input.reportPath)}: ${observed}`;
  if (timedOut)
    hypotheses.unshift({
      cause: `Test timed out after ${target.durationMs} ms`,
      confidence: "high",
      evidence: [source],
    });
  if (assertion)
    hypotheses.unshift({
      cause: `Assertion failure in ${target.testId}`,
      confidence: "high",
      evidence: [source],
    });
  return { hypotheses, timedOut, assertion };
}

function failureStatus(sig: Signatures): FailureStatus {
  if (sig.timedOut) return "timeout";
  if (sig.hypotheses.some((item) => /crash/i.test(item.cause))) return "crash";
  return sig.assertion ? "assertion-failure" : "error";
}

/** Analyse one failing case using only supplied evidence. */
export function analyzeTestFailure(input: FailureInput): FailureReport {
  let xml: string;
  try {
    xml = readFileSync(input.reportPath, "utf8");
  } catch (error) {
    return insufficient(input, `report not readable (${errorMessage(error)})`);
  }
  const cases = parseJUnitXml(xml);
  if (cases.length === 0) return insufficient(input, "no <testcase> elements in report");
  const target = findFailure(input, cases);
  if (!target || target.status !== "failed")
    return insufficient(
      input,
      input.testId ? "requested test is not a failure" : "no failed test in report",
    );

  const logcat = readOptional(input.logcatPath);
  const gradle = readOptional(input.gradlePath);
  const observed = redactDiagnosticText(target.message || target.stack.split(/\r?\n/)[0] || "");
  const stackLines = stackLinesOf(target.stack);
  const sig = signatures(input, target, logcat, gradle, observed);
  const status = failureStatus(sig);
  const report: FailureReport = {
    status,
    testId: target.testId,
    source: input.reportPath,
    observed,
    stackLines,
    hypotheses: sig.hypotheses,
    evidence: evidenceLines(input, target, stackLines, observed),
    unknowns: [],
    metadata: {
      ...redactMetadata(input.metadata),
      suite: target.classname,
      durationMs: String(target.durationMs),
    },
    nextStep: "",
    insufficientEvidence: false,
  };
  if (!sig.assertion && !sig.timedOut && sig.hypotheses.length === 0)
    report.unknowns.push(
      "No assertion, crash or timeout signature found; root cause is unconfirmed",
    );
  report.nextStep = nextStepFor(status, report);
  return report;
}

interface Outcome {
  v: 1;
  testId: string;
  status: OutcomeStatus;
  environment: Record<string, string>;
  at: string;
}

function readOutcomes(): Outcome[] {
  const file = join(historyDir(), "outcomes.jsonl");
  if (!existsSync(file)) return [];
  const records: Outcome[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Outcome;
      if (record && typeof record.testId === "string") records.push(record);
    } catch {
      continue;
    }
  }
  return records;
}

/** Append one outcome to the local history with bounded retention. */
export function recordTestOutcome(input: OutcomeInput): void {
  if (excluded(input.testId)) return;
  const dir = historyDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "outcomes.jsonl");
  const prior = readOutcomes().map((record) => JSON.stringify(record));
  const record: Outcome = {
    v: 1,
    testId: input.testId,
    status: input.status,
    environment: input.environment ?? {},
    at: input.at ?? new Date().toISOString(),
  };
  writeFileSync(file, [...prior, JSON.stringify(record)].slice(-historyKeep()).join("\n") + "\n");
}

function environmentKey(environment: Record<string, string>): string {
  return Object.entries(environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

/** Flaky means repeated, inconsistent outcomes under the same environment key. */
export function flakyTestHistory(options: HistoryOptions = {}): FlakyEntry[] {
  const minRuns = Math.max(2, options.minRuns ?? 3);
  const grouped = new Map<string, Outcome[]>();
  for (const record of readOutcomes()) {
    if (options.testId && record.testId !== options.testId) continue;
    if (excluded(record.testId, options.excludeTestIds)) continue;
    const key = `${record.testId}|${environmentKey(record.environment)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const results: FlakyEntry[] = [];
  for (const runs of grouped.values()) {
    if (runs.length < minRuns) continue;
    const passes = runs.filter((run) => run.status === "pass").length;
    const failures = runs.filter((run) => run.status === "fail").length;
    if (passes === 0 || failures === 0) continue;
    results.push({
      testId: runs[0].testId,
      environment: runs[0].environment,
      runs: runs.length,
      passes,
      failures,
      evidence: [
        `${runs.length} runs: ${passes} pass / ${failures} fail (${environmentKey(runs[0].environment)})`,
      ],
    });
  }
  return results.sort((a, b) => a.testId.localeCompare(b.testId));
}

function bundleMarkdown(input: BundleInput, report: FailureReport): string {
  const lines = [
    "# Test failure bundle",
    `generatedAt=${new Date().toISOString()}`,
    `status=${report.status}`,
    `testId=${report.testId ?? "unknown"}`,
    `source=${redactDiagnosticText(report.source)}`,
    "",
    "## Metadata",
  ];
  for (const [key, value] of Object.entries(report.metadata))
    lines.push(`- ${key}: ${redactDiagnosticText(value)}`);
  lines.push("", "## Diagnosis", `observed=${redactDiagnosticText(report.observed)}`);
  for (const line of report.stackLines) lines.push(`  ${redactDiagnosticText(line)}`);
  lines.push("", "## Hypotheses");
  if (report.hypotheses.length === 0) lines.push("- none established");
  for (const hypothesis of report.hypotheses) {
    lines.push(`- [${hypothesis.confidence}] ${redactDiagnosticText(hypothesis.cause)}`);
    for (const item of hypothesis.evidence) lines.push(`  - ${redactDiagnosticText(item)}`);
  }
  lines.push("", "## Evidence");
  for (const item of report.evidence) lines.push(`- ${redactDiagnosticText(item)}`);
  if (input.logcatPath) lines.push(`- logcatPath=${redactDiagnosticText(input.logcatPath)}`);
  if (input.gradlePath) lines.push(`- gradlePath=${redactDiagnosticText(input.gradlePath)}`);
  lines.push("", "## Unknowns");
  if (report.unknowns.length === 0) lines.push("- none recorded");
  for (const item of report.unknowns) lines.push(`- ${redactDiagnosticText(item)}`);
  lines.push(
    "",
    "## Next step",
    redactDiagnosticText(report.nextStep),
    "",
    "## Review checklist",
    "- [ ] Confirm the failing test ID and report source",
    "- [ ] Confirm no secrets or user paths remain in this bundle",
    "- [ ] Confirm hypotheses are labelled by confidence, not stated as proven",
    "",
  );
  return lines.join("\n");
}

/** Write a single, redacted, inspectable markdown bundle to local history. */
export function buildFailureBundle(input: BundleInput): BundleResult {
  const report = analyzeTestFailure(input);
  const dir = join(historyDir(), "bundles");
  mkdirSync(dir, { recursive: true });
  const safeId = (report.testId ?? input.testId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, `failure-${safeId.slice(0, 80)}-${Date.now()}.md`);
  writeFileSync(path, bundleMarkdown(input, report));
  return { path, report };
}
