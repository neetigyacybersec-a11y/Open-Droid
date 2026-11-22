// ISSUE-31: deterministic, read-only test strategy planner. Builds a prioritized
// test plan from project inventory, feature-spec requirements and changed files.
// Existing coverage is heuristic and honestly separated from additions; nothing
// is claimed without evidence and nothing modifies the project unless requested.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { inspectProject, type ProjectModule } from "./projectInspect.js";

export type TestLevel = "unit" | "integration" | "e2e" | "manual";
export type RiskLevel = "low" | "medium" | "high";
export type Confidence = "high" | "medium" | "low";

export interface TestClassInventory {
  className: string;
  package: string;
  framework: string;
  file: string;
}

export interface PlanItem {
  priority: number;
  level: TestLevel;
  name: string;
  requirementId?: string;
  rationale: string;
  existing: boolean;
  evidence: string;
}

export interface RequirementPlan {
  id: string;
  text: string;
  source: string;
  cases: string[];
  testCases: PlanItem[];
}

export interface PlanSeparation {
  existing: PlanItem[];
  additions: PlanItem[];
}

export interface ChangedFileTestPlan {
  module: string;
  tests: string[];
  why: string;
}

export interface RiskPlan {
  riskLevel: RiskLevel;
  coverageFloor: TestLevel[];
  summary: string;
}

export interface Assumption {
  statement: string;
  confidence: Confidence;
}

export interface TestPlanReport {
  status: "ok" | "error";
  projectPath: string;
  reason?: string;
  projectType: string;
  frameworks: string[];
  existingTests: { unit: TestClassInventory[]; instrumented: TestClassInventory[] };
  requirements: RequirementPlan[];
  plan: PlanSeparation;
  changedFilePlan: { changedFiles: string[]; relevantTests: ChangedFileTestPlan[] };
  riskPlan: RiskPlan;
  assumptions: Assumption[];
  matrix: string[];
  summary: string;
  artifact: { path: string; bytes: number } | null;
}

export interface TestPlanInput {
  projectPath: string;
  featureSpecPath?: string;
  changedFiles?: string[];
  riskLevel?: RiskLevel;
  saveArtifact?: boolean;
  artifactName?: string;
}

interface Inventory {
  unit: TestClassInventory[];
  instrumented: TestClassInventory[];
}

const DEFAULT_ARTIFACT = "TEST_PLAN.md";
const RISK_COVERAGE: Record<RiskLevel, TestLevel[]> = {
  low: ["unit"],
  medium: ["unit", "integration"],
  high: ["unit", "integration", "e2e"],
};
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
const FRAMEWORK_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/junit:junit:5|junit-platform|junit5/i, "junit5"],
  [/junit:junit:4/i, "junit4"],
  [/junit:junit:3/i, "junit3"],
  [/org\.junit\.jupiter|junit\.jupiter/i, "junit5"],
  [/org\.robolectric/i, "robolectric"],
  [/roborazzi/i, "roborazzi"],
  [/espresso/i, "espresso"],
  [/compose\.ui:ui-test|androidx\.compose\.ui:ui-test/i, "compose-ui"],
  [/kotlin-test|org\.jetbrains\.kotlin\.test/i, "kotlin-test"],
  [/mockito|mockk/i, "mocking"],
];

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function walkFiles(root: string, depth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    if (d > depth) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(child, d + 1);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out.sort();
}

function packageOf(file: string, srcRoot: string): string {
  const rel = relative(srcRoot, file).split(sep).join("/");
  const segments = rel.slice(0, rel.lastIndexOf(".")).split("/");
  while (segments[0] === "java" || segments[0] === "kotlin") segments.shift();
  return segments.slice(0, -1).join(".");
}

function detectFrameworks(moduleTexts: readonly string[], hasAndroidTest: boolean): string[] {
  const found = new Set<string>();
  for (const text of moduleTexts) {
    for (const [pattern, name] of FRAMEWORK_PATTERNS) if (pattern.test(text)) found.add(name);
    if (/androidTestImplementation|androidTestRuntimeOnly|androidTestCompileOnly/i.test(text))
      found.add("instrumented");
  }
  if (hasAndroidTest) found.add("instrumented");
  return [...found].sort();
}

function inventoryTests(projectPath: string, modules: readonly ProjectModule[]): Inventory {
  const inventory: Inventory = { unit: [], instrumented: [] };
  for (const module of modules) {
    for (const [relPath, bucket] of [
      [join("src", "test"), "unit"],
      [join("src", "androidTest"), "instrumented"],
    ] as const) {
      const root = join(projectPath, module.path, relPath);
      for (const file of walkFiles(root).filter((f) => /\.(kt|java)$/.test(f))) {
        const text = readTextFile(file) ?? "";
        const match =
          /(?:abstract\s+)?(?:public\s+)?(?:final\s+)?class\s+([A-Za-z][A-Za-z0-9_]*)/.exec(text);
        if (!match) continue;
        const entry: TestClassInventory = {
          className: match[1],
          package: packageOf(file, root),
          framework: bucket,
          file: relative(projectPath, file).split(sep).join("/"),
        };
        inventory[bucket].push(entry);
      }
    }
  }
  return inventory;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

interface RequirementDraft {
  id: string;
  cases: string[];
}

function toRequirement(draft: RequirementDraft, source: string): RequirementPlan {
  return {
    id: draft.id,
    text: draft.cases.join(" "),
    source,
    cases: [...draft.cases],
    testCases: [],
  };
}

function pushRequirementLine(
  requirements: RequirementPlan[],
  current: RequirementDraft | null,
  line: string,
  source: string,
): RequirementDraft | null {
  const heading = /^#{1,6}\s+(.+)$/.exec(line.trimEnd());
  if (heading) {
    if (current) requirements.push(toRequirement(current, source));
    return { id: slugify(heading[1]), cases: [] };
  }
  const bullet =
    /^[-*]\s+(.+)$/.exec(line.trim())?.[1] ?? /^\d+[.)]\s+(.+)$/.exec(line.trim())?.[1];
  if (bullet && current) current.cases.push(bullet.trim());
  return current;
}

function parseRequirements(text: string, source: string): RequirementPlan[] {
  const requirements: RequirementPlan[] = [];
  let current: RequirementDraft | null = null;
  for (const line of text.split(/\r?\n/))
    current = pushRequirementLine(requirements, current, line, source);
  if (current) requirements.push(toRequirement(current, source));
  return requirements.filter((r) => r.id.length > 0 && r.cases.length > 0);
}

function caseTokens(name: string): string[] {
  return [...name.toLowerCase().matchAll(/[a-z]{4,}/g)].map((m) => m[0]);
}

function coveredBy(inventory: Inventory, caseName: string): boolean {
  const tokens = caseTokens(caseName);
  if (tokens.length === 0) return false;
  const targets = [...inventory.unit, ...inventory.instrumented].map((t) =>
    `${t.className} ${t.package} ${t.framework} ${basename(t.file)}`.toLowerCase(),
  );
  const overlaps = (target: string): string[] =>
    tokens.filter((tok) => target.includes(tok) || target.includes(tok.replace(/s$/, "")));
  return targets.some((target) => overlaps(target).length >= 2);
}

const PERMISSION_RE = /permission|runtime-permission|android\.\w+\.PERMISSION/i;
const INTEGRATION_RE =
  /room|database|sqlite|dao|realm|persist|cache|localstorage|storage|network|http|api\b|server|endpoint|offline|retry/i;
const UI_RE = /compose|screen|snackbar|view|dialog|animation|toast|ui-test/i;

function classifyLevel(text: string): TestLevel {
  if (PERMISSION_RE.test(text)) return "manual";
  if (INTEGRATION_RE.test(text)) return "integration";
  if (UI_RE.test(text)) return "e2e";
  return "unit";
}

function computePlan(
  requirements: readonly RequirementPlan[],
  inventory: Inventory,
): PlanSeparation {
  const existing: PlanItem[] = [];
  const additions: PlanItem[] = [];
  let priority = 0;
  for (const requirement of requirements) {
    for (const text of requirement.cases) {
      const level = classifyLevel(text);
      const isExisting = coveredBy(inventory, text);
      const item: PlanItem = {
        priority: ++priority,
        level,
        name: text.length > 120 ? `${text.slice(0, 117)}…` : text,
        requirementId: requirement.id,
        rationale: `Requirement "${requirement.id}": ${level} coverage — ${text}`,
        existing: isExisting,
        evidence: requirement.id,
      };
      requirement.testCases.push(item);
      (isExisting ? existing : additions).push(item);
    }
  }
  return { existing, additions };
}

function modulePathFor(modules: readonly ProjectModule[], file: string): string {
  for (const module of modules)
    if (module.path === "." || file.startsWith(`${module.path}/`)) return module.path;
  return file.split("/")[0];
}

function testsByModule(
  modules: readonly ProjectModule[],
  inventory: Inventory,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of [...inventory.unit, ...inventory.instrumented]) {
    const modulePath = modulePathFor(modules, entry.file);
    const names = map.get(modulePath) ?? [];
    if (!names.includes(entry.className)) names.push(entry.className);
    map.set(modulePath, names);
  }
  return map;
}

function computeChangedFilePlan(
  modules: readonly ProjectModule[],
  inventory: Inventory,
  changedFiles: readonly string[],
): TestPlanReport["changedFilePlan"] {
  const testsBy = testsByModule(modules, inventory);
  const relevantTests: ChangedFileTestPlan[] = [];
  for (const file of changedFiles) {
    for (const module of modules) {
      if (module.path === "." ? true : file.startsWith(`${module.path}/`) || module.path === file) {
        const tests = testsBy.get(module.path) ?? [];
        relevantTests.push({
          module: module.path,
          tests,
          why: `module ${module.path} changed (${file}); related tests: ${tests.length > 0 ? tests.join(", ") : "none found"}`,
        });
      }
    }
  }
  return { changedFiles: [...changedFiles], relevantTests };
}

function matrixFor(modules: readonly ProjectModule[]): string[] {
  const levels = new Set<string>();
  for (const module of modules) {
    for (const value of [module.sdk.compileSdk, module.sdk.minSdk, module.sdk.targetSdk])
      if (value) levels.add(`api-${value}`);
  }
  return [...levels].sort((a, b) => a.localeCompare(b));
}

function computeAssumptions(frameworks: readonly string[], hasManualItems: boolean): Assumption[] {
  const list: Assumption[] = [
    {
      statement:
        "Plan is a static heuristic from build files and change lists; verify critical items by executing the tests before trusting device-only behavior.",
      confidence: "medium",
    },
  ];
  if (hasManualItems)
    list.push({
      statement:
        "Manual items need an interactive tester; they are heuristic suggestions for review.",
      confidence: "medium",
    });
  if (frameworks.includes("robolectric"))
    list.push({
      statement: "Robolectric unit tests run on the JVM headless — no device required.",
      confidence: "high",
    });
  if (frameworks.includes("espresso"))
    list.push({
      statement:
        "Espresso tests require a device or emulator; CI provides one and `make emulator-boot` boots it locally.",
      confidence: "medium",
    });
  return list;
}

function summarize(modules: readonly ProjectModule[], plan: PlanSeparation): string {
  return `Project has ${modules.length} module(s), ${plan.existing.length} existing test case(s), ${plan.additions.length} addition(s) to add.`;
}

/** Render the report as a deterministic Markdown document (used by the tool handler). */
export function renderTestPlan(report: TestPlanReport): string {
  const lines = [
    "# Test plan",
    `status=${report.status}`,
    `projectType=${report.projectType}`,
    `frameworks=${report.frameworks.length > 0 ? report.frameworks.join(",") : "none"}`,
    "",
  ];
  lines.push("## Existing tests", "");
  if (report.existingTests.unit.length === 0 && report.existingTests.instrumented.length === 0) {
    lines.push("- none detected");
  } else {
    for (const t of report.existingTests.unit)
      lines.push(`- ${t.className} (${t.package}) [${t.file}]`);
    for (const t of report.existingTests.instrumented)
      lines.push(`- [instrumented] ${t.className} (${t.package}) [${t.file}]`);
  }
  lines.push("", "## Requirements", "");
  for (const r of report.requirements) {
    lines.push(`- ${r.id}: ${r.text}`);
    for (const item of [...r.testCases])
      lines.push(
        `  - ${item.level}: ${item.name}${item.requirementId ? ` (${item.requirementId})` : ""}`,
      );
  }
  lines.push("", "## Plan", "", "### Existing coverage", "");
  lines.push(...report.plan.existing.map((i) => `- ${i.level}: ${i.name}`));
  lines.push("", "### Additions", "");
  lines.push(
    ...report.plan.additions.map((i) => `- [${i.priority}] ${i.level}: ${i.name} — ${i.rationale}`),
  );
  lines.push("", "## Assumptions", "");
  lines.push(...report.assumptions.map((a) => `- ${a.confidence}: ${a.statement}`));
  lines.push("", "## Matrix", "", ...report.matrix.map((m) => `- ${m}`));
  lines.push(
    "",
    "## Risk plan",
    `- riskLevel=${report.riskPlan.riskLevel}`,
    ...report.riskPlan.coverageFloor.map((f) => `- ${f}`),
  );
  lines.push("", "## Changed file plan", "");
  for (const entry of report.changedFilePlan.relevantTests) {
    lines.push(`- module ${entry.module}: ${entry.why}`);
  }
  lines.push("", "## Summary", report.summary);
  if (report.artifact)
    lines.push(`artifact=${report.artifact.path} (${report.artifact.bytes} bytes)`);
  lines.push("");
  return lines.join("\n");
}

function emptyReport(input: TestPlanInput): TestPlanReport {
  return {
    status: "error",
    projectPath: input.projectPath,
    reason: "project path does not exist",
    projectType: "unknown",
    frameworks: [],
    existingTests: { unit: [], instrumented: [] },
    requirements: [],
    plan: { existing: [], additions: [] },
    changedFilePlan: { changedFiles: input.changedFiles ?? [], relevantTests: [] },
    riskPlan: {
      riskLevel: input.riskLevel ?? "medium",
      coverageFloor: [...RISK_COVERAGE[input.riskLevel ?? "medium"]],
      summary: "",
    },
    assumptions: [],
    matrix: [],
    summary: "",
    artifact: null,
  };
}

/** Generate a prioritized test plan. Read-only unless saveArtifact is requested. */
export function generateTestPlan(input: TestPlanInput): TestPlanReport {
  if (!existsSync(input.projectPath)) return emptyReport(input);
  const inspect = inspectProject({ projectPath: input.projectPath });
  const modules = inspect.modules;
  const inventory = inventoryTests(input.projectPath, modules);
  const frameworkTexts = modules.map(
    (m) =>
      readTextFile(join(input.projectPath, m.path, "build.gradle.kts")) ??
      readTextFile(join(input.projectPath, m.path, "build.gradle")) ??
      "",
  );
  const hasAndroidTest = modules.some(
    (m) => walkFiles(join(input.projectPath, m.path, "src", "androidTest")).length > 0,
  );
  const frameworks = detectFrameworks(frameworkTexts, hasAndroidTest);
  const requirements = input.featureSpecPath
    ? parseRequirements(readTextFile(input.featureSpecPath) ?? "", input.featureSpecPath)
    : [];
  const plan = computePlan(requirements, inventory);
  const changedFiles = input.changedFiles ?? [];
  const changedFilePlan = computeChangedFilePlan(modules, inventory, changedFiles);
  const riskLevel: RiskLevel = input.riskLevel ?? "medium";
  const hasManualItems = [...plan.existing, ...plan.additions].some((i) => i.level === "manual");
  const riskPlan: RiskPlan = {
    riskLevel,
    coverageFloor: [...RISK_COVERAGE[riskLevel]],
    summary: `riskLevel=${riskLevel}: coverage floor is ${RISK_COVERAGE[riskLevel].join("/")}; treat "manual" items as untested until a tester signs off.`,
  };
  const report: TestPlanReport = {
    status: "ok",
    projectPath: input.projectPath,
    projectType: inspect.projectType,
    frameworks,
    existingTests: inventory,
    requirements,
    plan,
    changedFilePlan,
    riskPlan,
    assumptions: computeAssumptions(frameworks, hasManualItems),
    matrix: matrixFor(modules),
    summary: "",
    artifact: null,
  };
  report.summary = summarize(modules, plan);
  if (input.saveArtifact) {
    const markdown = renderTestPlan(report);
    report.artifact = { path: input.artifactName ?? DEFAULT_ARTIFACT, bytes: markdown.length };
    writeFileSync(join(input.projectPath, report.artifact.path), markdown);
  }
  return report;
}
