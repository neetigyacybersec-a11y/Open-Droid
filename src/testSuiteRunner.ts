// ISSUE-32: unified Android test-suite runner with failure triage output. One
// tool orchestrates the project's test entry points: discovers configured
// suites from the project structure, runs them (or reports them skipped),
// preserves raw evidence under predictable artifact directories, and reports
// per-suite exit codes with bounded summaries that separate evidence from
// interpretation.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run, type RunResult, type RunOptions } from "./services/process-runner.js";
import { gradleArgv } from "./gradleExecutable.js";
import { inspectProject } from "./projectInspect.js";
import { parseJUnitXml } from "./testDiagnostics.js";

export type SuiteName = "unit" | "instrumented" | "coverage" | "maestro" | "benchmark";
export type SuiteSelection = SuiteName | "all" | "ui";

export interface SuiteSpec {
  name: SuiteName;
  modules: string[];
  commands: string[][];
  artifactDirs: string[];
  flows?: string[];
}

export interface SuiteRunResult {
  name: SuiteName;
  status: "ran" | "skipped";
  exitCode: number | null;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  artifactXmls: string[];
  failureSummary: { testId: string | null; message: string; stackLines: string[] }[];
  reason?: string;
}

export interface TestSuiteRunReport {
  status: "ok" | "partial" | "failed" | "skipped";
  selected: SuiteSelection;
  suites: SuiteRunResult[];
  passed: number;
  failed: number;
  skipped: number;
  unknown: number;
  commands: string[];
  durationMs: number;
}

export type SuiteRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export interface TestSuiteRunInput {
  projectPath: string;
  suite?: SuiteSelection;
  module?: string;
  flowPaths?: string[];
  gradleArgs?: string[];
  offline?: boolean;
  timeoutMs?: number;
  continueOnFailure?: boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_XMLS = 50;
const MAX_FAILURES = 10;
const EXCLUDED_DIRS = new Set([
  "build",
  "node_modules",
  ".git",
  ".gradle",
  "generated",
  "out",
  "dist",
  "target",
  ".idea",
]);

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (!existsSync(dir) || depth > 6) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      walkFiles(child, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

function modulePaths(projectPath: string): string[] {
  const modules = inspectProject({ projectPath }).modules.map((m) => m.path);
  return modules.length > 0 ? modules : ["."];
}

function gradlePath(modulePath: string): string {
  return modulePath === "." ? ":" : `:${modulePath}`;
}

function readModuleText(projectPath: string, modulePath: string): string {
  return (
    readText(join(projectPath, modulePath, "build.gradle.kts")) ??
    readText(join(projectPath, modulePath, "build.gradle")) ??
    ""
  );
}

function artifactDirsFor(projectPath: string, modulePath: string, suite: SuiteName): string[] {
  const dir = join(projectPath, modulePath, "build");
  if (suite === "unit")
    return [
      join(dir, "test-results", "testDebugUnitTest"),
      join(dir, "test-results", "testReleaseUnitTest"),
    ];
  if (suite === "instrumented")
    return [join(dir, "outputs", "androidTest-results", "connectedDebugAndroidTest")];
  if (suite === "coverage") return [join(dir, "reports", "coverage")];
  return [];
}

function findFlows(projectPath: string): string[] {
  const flows: string[] = [];
  for (const file of walkFiles(projectPath)) {
    if (!/\.ya?ml$/i.test(basename(file))) continue;
    const text = readText(file);
    if (text && /^appId:\s*\S+/m.test(text)) flows.push(file);
  }
  return flows.sort();
}

function moduleFilter(input: TestSuiteRunInput, modules: string[]): string[] {
  if (!input.module) return modules;
  return modules.filter((m) => m === input.module || gradlePath(m) === input.module);
}

function suiteSpecs(input: TestSuiteRunInput): SuiteSpec[] {
  const projectPath = input.projectPath;
  const modules = moduleFilter(input, modulePaths(projectPath));
  const byName = new Map<string, SuiteSpec>();
  const add = (spec: SuiteSpec): void => {
    // One spec per (suite, module): keying by name alone skips every module
    // after the first in multi-module projects.
    const key = `${spec.name}:${spec.modules.join(",")}`;
    if (!byName.has(key)) byName.set(key, spec);
  };
  for (const modulePath of modules) {
    const text = readModuleText(projectPath, modulePath);
    const g = gradlePath(modulePath);
    if (
      existsSync(join(projectPath, modulePath, "src", "test")) ||
      /testImplementation|testRuntimeOnly/i.test(text)
    )
      add({
        name: "unit",
        modules: [modulePath],
        commands: [["gradle", `${g}:testDebugUnitTest`]],
        artifactDirs: artifactDirsFor(projectPath, modulePath, "unit"),
      });
    if (existsSync(join(projectPath, modulePath, "src", "androidTest")))
      add({
        name: "instrumented",
        modules: [modulePath],
        commands: [["gradle", `${g}:connectedDebugAndroidTest`]],
        artifactDirs: artifactDirsFor(projectPath, modulePath, "instrumented"),
      });
    if (/jacoco|createDebugCoverageReport/i.test(text))
      add({
        name: "coverage",
        modules: [modulePath],
        commands: [["gradle", `${g}:createDebugCoverageReport`]],
        artifactDirs: artifactDirsFor(projectPath, modulePath, "coverage"),
      });
  }
  const flows =
    input.flowPaths && input.flowPaths.length > 0 ? input.flowPaths : findFlows(projectPath);
  if (flows.length > 0)
    add({
      name: "maestro",
      modules: [],
      commands: [["maestro", "test", ...flows]],
      artifactDirs: [],
      flows,
    });
  return [...byName.values()];
}

// Content digests, not mtimes: CI filesystems can round mtime to whole seconds,
// which makes a freshly written XML look older than the run that produced it.
type XmlDigests = Map<string, string>;
function xmlDigests(dirs: readonly string[]): XmlDigests {
  const digests: XmlDigests = new Map();
  for (const dir of dirs)
    for (const file of walkFiles(dir))
      if (/\.xml$/i.test(file))
        digests.set(
          file,
          createHash("sha256")
            .update(readText(file) ?? "")
            .digest("hex"),
        );
  return digests;
}
function scanXmls(dirs: readonly string[], before: XmlDigests): string[] {
  const out: string[] = [];
  for (const dir of dirs)
    out.push(
      ...walkFiles(dir).filter((f) => {
        if (!/\.xml$/i.test(f)) return false;
        return (
          before.get(f) !==
          createHash("sha256")
            .update(readText(f) ?? "")
            .digest("hex")
        );
      }),
    );
  return out.sort().slice(0, MAX_XMLS);
}

interface CaseCounts {
  passed: number;
  failed: number;
  skipped: number;
}

function countXmlCases(xml: string, counts: CaseCounts): void {
  for (const testCase of parseJUnitXml(readText(xml) ?? "")) {
    if (testCase.status === "passed") counts.passed++;
    else if (testCase.status === "failed") counts.failed++;
    else if (testCase.status === "skipped") counts.skipped++;
  }
}

function countStatus(xmls: readonly string[]): CaseCounts {
  const counts: CaseCounts = { passed: 0, failed: 0, skipped: 0 };
  for (const xml of xmls) countXmlCases(xml, counts);
  return counts;
}

function failureSummaryOf(xmls: readonly string[]): SuiteRunResult["failureSummary"] {
  const summary: SuiteRunResult["failureSummary"] = [];
  for (const xml of xmls) {
    if (summary.length >= MAX_FAILURES) break;
    for (const testCase of parseJUnitXml(readText(xml) ?? "")) {
      if (testCase.status !== "failed" || summary.length >= MAX_FAILURES) continue;
      summary.push({
        testId: testCase.testId,
        message: testCase.message,
        stackLines: testCase.stack
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 6),
      });
    }
  }
  return summary;
}

function skippedSuite(name: SuiteName, reason: string): SuiteRunResult {
  return {
    name,
    status: "skipped",
    exitCode: null,
    durationMs: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    artifactXmls: [],
    failureSummary: [],
    reason,
  };
}

function describeNotConfigured(name: SuiteName): string {
  const hints: Record<SuiteName, string> = {
    unit: "no module with src/test or testImplementation in build files",
    instrumented: "no module with src/androidTest or androidTestImplementation in build files",
    coverage: "no JaCoCo or createDebugCoverageReport task in build files",
    maestro: "no YAML files with an appId were found",
    benchmark:
      "benchmark suites are not implemented (use unit, instrumented, coverage, maestro, or all)",
  };
  return `suite "${name}" is not configured: ${hints[name]}`;
}

interface MissingSuite {
  name: SuiteName;
  reason: string;
}

function selectedSpecs(input: TestSuiteRunInput): {
  selected: SuiteSpec[];
  missing: MissingSuite[];
} {
  const specs = suiteSpecs(input);
  const sel: SuiteName | "all" | undefined = input.suite === "ui" ? "instrumented" : input.suite;
  const wanted = sel && sel !== "all" ? specs.filter((spec) => spec.name === sel) : specs;
  const missing: MissingSuite[] = [];
  if (input.suite && input.suite !== "all") {
    if (input.suite === "benchmark") {
      missing.push({ name: "benchmark", reason: describeNotConfigured("benchmark") });
    } else if (sel && sel !== "all" && !specs.some((spec) => spec.name === sel)) {
      missing.push({ name: sel, reason: describeNotConfigured(sel) });
    }
  }
  return { selected: wanted, missing };
}

const DEFAULT_RUNNER: SuiteRunner = (cmd, args, opts) =>
  run(cmd, args, { timeout: opts.timeout, cwd: opts.cwd });

async function executeSuite(
  input: TestSuiteRunInput,
  spec: SuiteSpec,
  runner: SuiteRunner,
): Promise<{ suite: SuiteRunResult; command: string }> {
  const command = [...spec.commands[0]];
  if (spec.name === "unit" && input.gradleArgs?.length) command.push(...input.gradleArgs);
  if (spec.name === "unit" && input.offline) command.push("--offline");
  const started = Date.now();
  const before = xmlDigests(spec.artifactDirs);
  const argv = command[0] === "gradle" ? gradleArgv(command.slice(1)) : command;
  const result = await runner(argv[0], argv.slice(1), {
    timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cwd: input.projectPath,
  });
  const xmls = scanXmls(spec.artifactDirs, before);
  const counts = countStatus(xmls);
  return {
    suite: {
      name: spec.name,
      status: "ran",
      exitCode: result.code,
      durationMs: Date.now() - started,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      artifactXmls: xmls,
      failureSummary: failureSummaryOf(xmls),
    },
    command: command.join(" "),
  };
}

/** Run a configured suite or orchestrstrate configured suites. Never writes. */
export async function runSuite(
  input: TestSuiteRunInput,
  runner: SuiteRunner = DEFAULT_RUNNER,
): Promise<TestSuiteRunReport> {
  const started = Date.now();
  const { selected, missing } = selectedSpecs(input);
  const suites: SuiteRunResult[] = [];
  const commands: string[] = [];
  for (const spec of selected) {
    const { suite, command } = await executeSuite(input, spec, runner);
    suites.push(suite);
    commands.push(command);
  }
  for (const { name, reason } of missing) suites.push(skippedSuite(name, reason));
  const anyFailed = suites.some((suite) => suite.status === "ran" && suite.exitCode !== 0);
  let status: TestSuiteRunReport["status"];
  if (suites.length === 0) status = "skipped";
  else if (suites.every((suite) => suite.status === "skipped")) status = "skipped";
  else if (anyFailed && input.continueOnFailure === false) status = "failed";
  else if (anyFailed) status = "partial";
  else status = "ok";
  return {
    status,
    selected: input.suite ?? "all",
    suites,
    passed: suites.reduce((sum, s) => sum + s.passed, 0),
    failed: suites.reduce((sum, s) => sum + s.failed, 0),
    skipped: suites.reduce((sum, s) => sum + s.skipped, 0),
    unknown: suites.filter((s) => s.status === "ran" && s.artifactXmls.length === 0).length,
    commands,
    durationMs: Date.now() - started,
  };
}

export function renderTestSuiteRun(report: TestSuiteRunReport): string {
  const lines = [
    `status=${report.status}`,
    `selected=${report.selected}`,
    `suites=${report.suites.map((s) => `${s.name}:${s.status}`).join(",")}`,
    `passed=${report.passed} failed=${report.failed} skipped=${report.skipped} unknown=${report.unknown}`,
    `commands=${report.commands.length}`,
    `durationMs=${report.durationMs}`,
  ];
  for (const suite of report.suites) {
    if (suite.status === "skipped")
      lines.push(`skipped ${suite.name}: ${suite.reason ?? "not configured"}`);
    for (const summary of suite.failureSummary.slice(0, 5)) {
      lines.push(`failure ${suite.name}: ${summary.testId} — ${summary.message.split(/\r?\n/)[0]}`);
      for (const line of summary.stackLines.slice(0, 3)) lines.push(`  at ${line}`);
    }
  }
  for (const command of report.commands) lines.push(`command: ${command.slice(0, 300)}`);
  return lines.join("\n");
}
