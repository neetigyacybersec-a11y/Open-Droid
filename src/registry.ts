// ISSUE-104: one typed registry is the source of truth for tool registration,
// safety classification, path policy, provenance, documentation and tests.
//
// Registration is a loop over this array. A tool cannot be registered without a
// schema, handler, risk class, approval requirement and test reference. Safety
// fields are required by the type system and re-checked at runtime so a
// malformed registry fails startup instead of silently defaulting a destructive
// tool to read-only or unattended.
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ToolSchemas } from "./tools.js";
import * as H from "./tools.js";
import type { SourceCategory } from "./provenance.js";
import type { PathOperation, ToolPathSpec } from "./workspace.js";

export const TOOL_CATEGORIES = Object.freeze([
  "environment",
  "build",
  "adb",
  "emulator",
  "frida",
  "network",
  "ui",
  "static-analysis",
  "testing",
  "profiling",
  "privacy",
  "security",
  "skills",
  "catalog",
] as const);

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const RISK_CLASSES = Object.freeze([
  "read-only",
  "local-write",
  "device-state",
  "destructive",
  "network-exposure",
  "external-write",
] as const);

export type RiskClass = (typeof RISK_CLASSES)[number];

export const APPROVAL_REQUIREMENTS = Object.freeze(["none", "confirmation", "expert"] as const);

export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];

/** Issue 50 impact classes. Argument-dependent refinement lives in executionPolicy. */
export const IMPACT_CLASSES = Object.freeze([
  "read-only",
  "local-reversible",
  "device-state",
  "destructive",
  "network-exposure",
  "external-write",
  "production",
] as const);

export type ImpactClass = (typeof IMPACT_CLASSES)[number];

/**
 * ISSUE-22: names that design notes or feature requests may mention but that
 * are deliberately not registered. The generated catalogue lists them so a
 * reader never has to guess whether a missing tool is broken or unbuilt.
 */
export interface PlannedTool {
  readonly name: string;
  readonly status: "not-implemented";
  readonly summary: string;
  /** GitHub issue numbers that track the feature request. */
  readonly tracking: readonly number[];
}

export const PLANNED_TOOLS: readonly PlannedTool[] = Object.freeze([
  Object.freeze({
    name: "screenshot_diff",
    status: "not-implemented",
    summary:
      "Pixel-diff a capture against a golden baseline. Use adb_screenshot for capture and Roborazzi verify in app tests until this tool exists.",
    tracking: Object.freeze([16, 18]),
  }),
  Object.freeze({
    name: "design_qa_matrix",
    status: "not-implemented",
    summary:
      "Capture light, dark, font-scale and landscape variants as one contact sheet. Use Robolectric/Roborazzi variants in app tests for now.",
    tracking: Object.freeze([18]),
  }),
  Object.freeze({
    name: "a11y_audit",
    status: "not-implemented",
    summary:
      "Audit tap targets, labels and sampled contrast over uiautomator. Use Roborazzi accessibility checks in app tests for now.",
    tracking: Object.freeze([18]),
  }),
]);

export type SideEffect =
  | "host-read"
  | "host-write"
  | "host-delete"
  | "device-read"
  | "device-write"
  | "device-delete"
  | "network-listen"
  | "network-egress"
  | "external-download"
  | "process-spawn"
  | "background-process"
  | "project-build";

const SOURCE_CATEGORIES: readonly SourceCategory[] = [
  "project",
  "build",
  "device",
  "static",
  "network",
  "mixed",
  "mcp",
];

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  readonly category: ToolCategory;
  readonly risk: RiskClass;
  /** Approval-policy key consumed by #50; null only for read-only tools. */
  readonly policyKey: string | null;
  readonly approval: ApprovalRequirement;
  readonly unattended: boolean;
  readonly source: SourceCategory;
  readonly sideEffects: readonly SideEffect[];
  /** Required host/device state or installed capability, one condition per entry. */
  readonly preconditions: readonly string[];
  readonly paths: readonly ToolPathSpec[];
  readonly tests: readonly string[];
  readonly verification: string;
  readonly alternative: string | null;
  /** Advisory execution bounds; handlers remain authoritative until #97 contracts. */
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
}

export interface ToolDefinitionInput<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<S>) => Promise<CallToolResult>;
  category: ToolCategory;
  risk: RiskClass;
  policyKey: string | null;
  approval: ApprovalRequirement;
  unattended: boolean;
  source: SourceCategory;
  sideEffects: readonly SideEffect[];
  preconditions: readonly string[];
  paths: readonly ToolPathSpec[];
  tests: readonly string[];
  verification: string;
  alternative?: string | null;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

const PATH_OPERATIONS: readonly PathOperation[] = ["read", "write", "delete"];

/**
 * The static impact of a tool, derived from its risk class. Tools whose impact
 * depends on arguments (for example a Gradle publish task) are refined by
 * executionPolicy.resolveImpact before a policy decision is made.
 */
export function baseImpact(entry: Pick<ToolDefinition, "risk">): ImpactClass {
  switch (entry.risk) {
    case "read-only":
      return "read-only";
    case "local-write":
      return "local-reversible";
    case "device-state":
      return "device-state";
    case "destructive":
      return "destructive";
    case "network-exposure":
      return "network-exposure";
    case "external-write":
      return "external-write";
    default:
      throw new Error(`unknown risk class: ${String((entry as { risk?: unknown }).risk)}`);
  }
}

function freezeSpec(spec: ToolPathSpec): ToolPathSpec {
  return Object.freeze({ field: spec.field, operation: spec.operation });
}

function path(field: string, operation: PathOperation): ToolPathSpec {
  return freezeSpec({ field, operation });
}

function defineTool<S extends z.ZodTypeAny>(input: ToolDefinitionInput<S>): ToolDefinition {
  return Object.freeze({
    ...input,
    schema: input.schema,
    // The registry erases each tool's concrete Zod-inferred argument type to a
    // common callable shape. Callers only pass schema-validated arguments, so
    // this single checked-in assertion is the documented type-erasure seam.
    handler: input.handler as unknown as (args: Record<string, unknown>) => Promise<CallToolResult>,
    sideEffects: Object.freeze([...input.sideEffects]),
    preconditions: Object.freeze([...input.preconditions]),
    paths: Object.freeze(input.paths.map(freezeSpec)),
    tests: Object.freeze([...input.tests]),
    alternative: input.alternative ?? null,
  });
}

/**
 * Validate the completeness invariants that TypeScript cannot fully express,
 * and fail closed on hand-written or generated objects with missing fields.
 */
export function validateToolRegistry(entries: readonly ToolDefinition[]): void {
  const problems: string[] = [];
  const names = new Set<string>();
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("invalid tool registry: registry must be a non-empty array");
  }
  for (const [index, entry] of entries.entries()) {
    const label = entry && typeof entry === "object" && entry.name ? entry.name : `entry ${index}`;
    if (!entry || typeof entry !== "object") {
      problems.push(`${label}: entry must be an object`);
      continue;
    }
    if (typeof entry.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(entry.name)) {
      problems.push(`${label}: name must match ^[a-z][a-z0-9_]*$`);
    }
    if (names.has(entry.name)) problems.push(`${label}: duplicate tool name`);
    names.add(entry.name);
    if (!entry.schema || typeof entry.schema.safeParse !== "function") {
      problems.push(`${label}: schema is required`);
    }
    if (typeof entry.handler !== "function") problems.push(`${label}: handler is required`);
    if (typeof entry.description !== "string" || entry.description.trim().length < 20) {
      problems.push(`${label}: description must be at least 20 characters`);
    }
    if (!TOOL_CATEGORIES.includes(entry.category)) {
      problems.push(`${label}: category must be one of ${TOOL_CATEGORIES.join(", ")}`);
    }
    if (!RISK_CLASSES.includes(entry.risk)) {
      problems.push(`${label}: risk must be one of ${RISK_CLASSES.join(", ")}`);
    } else {
      if (entry.risk === "read-only" && entry.policyKey !== null) {
        problems.push(`${label}: read-only tools must use a null policy key`);
      }
      if (entry.risk !== "read-only") {
        if (typeof entry.policyKey !== "string" || !/^[a-z][a-z0-9_.]*$/.test(entry.policyKey)) {
          problems.push(`${label}: policy key is required for ${entry.risk} tools`);
        }
      }
      if (
        ["device-state", "destructive", "network-exposure", "external-write"].includes(
          entry.risk,
        ) &&
        entry.approval === "none"
      ) {
        problems.push(`${label}: ${entry.risk} tools require an approval requirement`);
      }
      if (
        ["destructive", "network-exposure", "external-write"].includes(entry.risk) &&
        entry.unattended !== false
      ) {
        problems.push(`${label}: ${entry.risk} tools must not run unattended`);
      }
      if (entry.approval !== "none" && entry.unattended === true) {
        problems.push(`${label}: tools that require approval cannot be marked unattended`);
      }
    }
    if (!APPROVAL_REQUIREMENTS.includes(entry.approval)) {
      problems.push(`${label}: approval must be one of ${APPROVAL_REQUIREMENTS.join(", ")}`);
    }
    if (typeof entry.unattended !== "boolean") {
      problems.push(`${label}: unattended must be explicit`);
    }
    if (!SOURCE_CATEGORIES.includes(entry.source)) {
      problems.push(`${label}: source must be one of ${SOURCE_CATEGORIES.join(", ")}`);
    }
    if (!Array.isArray(entry.sideEffects)) problems.push(`${label}: sideEffects must be an array`);
    if (!Array.isArray(entry.preconditions)) {
      problems.push(`${label}: preconditions must be an array`);
    }
    if (!Array.isArray(entry.paths)) {
      problems.push(`${label}: paths must be an array`);
    } else {
      for (const spec of entry.paths) {
        if (!spec || typeof spec.field !== "string" || !spec.field) {
          problems.push(`${label}: every path spec needs a field`);
        } else if (!PATH_OPERATIONS.includes(spec.operation)) {
          problems.push(`${label}: ${spec.field} has an invalid path operation`);
        }
      }
    }
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) {
      problems.push(`${label}: at least one test reference is required`);
    }
    if (typeof entry.verification !== "string" || entry.verification.trim().length === 0) {
      problems.push(`${label}: verification evidence is required`);
    }
    if (
      entry.timeoutMs !== undefined &&
      (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)
    ) {
      problems.push(`${label}: timeoutMs must be a positive integer`);
    }
    if (
      entry.outputLimitBytes !== undefined &&
      (!Number.isInteger(entry.outputLimitBytes) || entry.outputLimitBytes <= 0)
    ) {
      problems.push(`${label}: outputLimitBytes must be a positive integer`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid tool registry:\n- ${problems.join("\n- ")}`);
  }
}

export interface ToolCatalogOptions {
  category?: string;
  risk?: string;
  safeOnly?: boolean;
}

/** Filter the registry for agent-facing discovery. Unknown filters fail closed. */
export function filterToolCatalog(options: ToolCatalogOptions = {}): readonly ToolDefinition[] {
  if (
    options.category !== undefined &&
    !TOOL_CATEGORIES.includes(options.category as ToolCategory)
  ) {
    throw new Error(
      `unknown category "${options.category}"; expected one of: ${TOOL_CATEGORIES.join(", ")}`,
    );
  }
  if (options.risk !== undefined && !RISK_CLASSES.includes(options.risk as RiskClass)) {
    throw new Error(`unknown risk "${options.risk}"; expected one of: ${RISK_CLASSES.join(", ")}`);
  }
  return TOOL_REGISTRY.filter((entry) => {
    if (options.category !== undefined && entry.category !== options.category) return false;
    if (options.risk !== undefined && entry.risk !== options.risk) return false;
    if (options.safeOnly && (entry.approval !== "none" || entry.unattended !== true)) return false;
    return true;
  });
}

function catalogSummary(entry: ToolDefinition) {
  return {
    name: entry.name,
    description: entry.description,
    category: entry.category,
    risk: entry.risk,
    impact: baseImpact(entry),
    approval: entry.approval,
    unattended: entry.unattended,
    policyKey: entry.policyKey,
    sideEffects: entry.sideEffects,
    preconditions: entry.preconditions,
    timeoutMs: entry.timeoutMs ?? null,
    outputLimitBytes: entry.outputLimitBytes ?? null,
    alternative: entry.alternative,
  };
}

/**
 * Agent-facing safe-tool discovery. The full expert catalogue remains available
 * through tools/list and through this tool when safeOnly is false.
 */
export async function handleToolCatalog(args: ToolCatalogOptions = {}) {
  try {
    const entries = filterToolCatalog(args);
    const groups = TOOL_CATEGORIES.map((category) => {
      const tools = entries
        .filter((entry) => entry.category === category)
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        category,
        risks: Object.fromEntries(
          RISK_CLASSES.map((risk) => [risk, tools.filter((entry) => entry.risk === risk).length]),
        ),
        tools: tools.map(catalogSummary),
      };
    }).filter((group) => group.tools.length > 0);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              schemaVersion: 1,
              safeOnly: Boolean(args.safeOnly),
              total: entries.length,
              riskSummary: Object.fromEntries(
                RISK_CLASSES.map((risk) => [
                  risk,
                  entries.filter((entry) => entry.risk === risk).length,
                ]),
              ),
              groups,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
      ],
      isError: true,
    };
  }
}

const SMOKE = "test/smoke.test.mjs";
const TOOLS = "test/tools.test.mjs";
const WORKSPACE = "test/workspace.test.mjs";

const DEVICE = "An authorised Android device or emulator is connected and visible to adb";
const WORKSPACE_ROOT = "ANDROID_MCP_WORKSPACE covers the project, APK or output path used";
const GRADLE = "Java and a Gradle wrapper or gradle executable are available";

/**
 * The complete, ordered tool catalogue. Categories follow TOOL_CATEGORIES so
 * discovery output is deterministic. Every safety field is explicit; a missing
 * field is a type error and a runtime validation failure.
 */
export const TOOL_REGISTRY: readonly ToolDefinition[] = Object.freeze([
  defineTool({
    name: "android_env_check",
    description:
      "Check installed Android toolchain (java, gradle, adb, emulator, sdkmanager, maestro, compose-preview, android CLI) and environment variables.",
    schema: ToolSchemas.envCheck,
    handler: () => H.handleEnvCheck(),
    category: "environment",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "mcp",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["Node.js and the host Android toolchain are installed"],
    paths: [],
    tests: [SMOKE, "test/build-info.test.mjs"],
    verification: "npm test — smoke registration and toolchain detection tests",
    alternative: null,
  }),
  defineTool({
    name: "sdkmanager_install",
    description:
      "Install or update Android SDK packages through sdkmanager, downloading artefacts from Google's repositories.",
    schema: ToolSchemas.sdkmanagerInstall,
    handler: (args) => H.handleSdkmanagerInstall(args),
    category: "environment",
    risk: "external-write",
    policyKey: "sdk.install",
    approval: "confirmation",
    unattended: false,
    source: "build",
    sideEffects: ["external-download", "host-write", "process-spawn"],
    preconditions: [
      "sdkmanager is on PATH",
      "SDK licences are accepted",
      "Network access to Google repositories",
    ],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; live install requires an SDK host",
    alternative: "Install SDK packages through Android Studio's SDK Manager",
  }),
  defineTool({
    name: "gradle_task",
    description:
      "Run an arbitrary Gradle task in a project directory; the task may publish artefacts or mutate files.",
    schema: ToolSchemas.gradle,
    handler: (args) => H.handleGradle(args),
    category: "build",
    risk: "destructive",
    policyKey: "gradle.task",
    approval: "expert",
    unattended: false,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-read", "host-write"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE, WORKSPACE],
    verification: "npm test — smoke registration and workspace path-policy tests",
    alternative: "Use build_variant, gradle_test or gradle_lint for a scoped operation",
    timeoutMs: 600_000,
    outputLimitBytes: 12_000,
  }),
  defineTool({
    name: "gradle_test",
    description:
      "Run the :app unit-test task in a project directory and return bounded Gradle output.",
    schema: ToolSchemas.gradleTest,
    handler: (args) => H.handleGradleTest(args),
    category: "build",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-read", "host-write"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; Gradle execution is host-dependent",
    alternative: null,
  }),
  defineTool({
    name: "gradle_lint",
    description: "Run the :app Android lint task and return the bounded report output.",
    schema: ToolSchemas.gradleLint,
    handler: (args) => H.handleGradleLint(args),
    category: "build",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-read", "host-write"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; lint execution is host-dependent",
    alternative: null,
  }),
  defineTool({
    name: "gradle_dependencies",
    description: "Print the resolved dependency graph for a Gradle configuration.",
    schema: ToolSchemas.gradleDependencies,
    handler: (args) => H.handleGradleDependencies(args),
    category: "build",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-read"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; dependency resolution is host-dependent",
    alternative: null,
  }),
  defineTool({
    name: "build_variant",
    description:
      "Assemble a named product-flavour variant after validating it against the module's available assemble tasks.",
    schema: ToolSchemas.buildVariant,
    handler: (args) => H.handleBuildVariant(args),
    category: "build",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-read", "host-write"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and variant validation tests",
    alternative: null,
  }),
  defineTool({
    name: "baseline_profile_generate",
    description:
      "Generate a Baseline Profile by running the module's connected instrumented tests.",
    schema: ToolSchemas.baselineProfileGenerate,
    handler: (args) => H.handleBaselineProfileGenerate(args),
    category: "build",
    risk: "device-state",
    policyKey: "device.test.instrumented",
    approval: "confirmation",
    unattended: false,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "device-write", "host-write"],
    preconditions: [GRADLE, DEVICE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; profile generation needs a device",
    alternative: "Generate the profile from Android Studio's Baseline Profile module",
  }),
  defineTool({
    name: "compose_preview_render",
    description:
      "Render Compose @Preview composables to PNG headlessly and return paths, hashes and optional inline images.",
    schema: ToolSchemas.composePreviewRender,
    handler: (args) => H.handleComposePreviewRender(args),
    category: "build",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "mixed",
    sideEffects: ["project-build", "process-spawn", "host-read", "host-write"],
    preconditions: ["compose-preview is installed", WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE, "test/compose-preview.test.mjs"],
    verification: "npm test — smoke registration and compose-preview rendering tests",
    alternative: null,
  }),
  defineTool({
    name: "adb_devices",
    description: "List connected Android devices and emulators with their adb state.",
    schema: ToolSchemas.adbDevices,
    handler: () => H.handleAdbDevices(),
    category: "adb",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: ["adb is on PATH"],
    paths: [],
    tests: [SMOKE, WORKSPACE],
    verification: "npm test — smoke registration and workspace path-policy tests",
    alternative: null,
  }),
  defineTool({
    name: "adb_screenshot",
    description:
      "Capture a screenshot of the device screen (screencap), save the PNG to an approved path, and return the PNG inline as image content.",
    schema: ToolSchemas.adbScreenshot,
    handler: (args) => H.handleAdbScreenshot(args),
    category: "adb",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT],
    paths: [path("outputPath", "write")],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and screenshot handler tests",
    alternative: null,
  }),
  defineTool({
    name: "adb_install",
    description: "Install an APK (app package) on a connected device or emulator.",
    schema: ToolSchemas.adbInstall,
    handler: (args) => H.handleAdbInstall(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.app.install",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "host-read", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT],
    paths: [path("apkPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; installation needs a device",
    alternative: "Install through Android Studio's Run configuration",
  }),
  defineTool({
    name: "adb_launch",
    description:
      "Launch an app on the device (am start), with an optional activity, falling back to a launcher intent.",
    schema: ToolSchemas.adbLaunch,
    handler: (args) => H.handleAdbLaunch(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "process-spawn"],
    preconditions: [DEVICE, "The target package is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and launch handler tests",
    alternative: "Start the activity from the device launcher",
  }),
  defineTool({
    name: "adb_push",
    description: "Copy a host file to an explicit path on a device or emulator.",
    schema: ToolSchemas.adbPush,
    handler: (args) => H.handleAdbPush(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.file.push",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "host-read", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT, "The remote directory exists and is writable"],
    paths: [path("localPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; push needs a device",
    alternative: "Use the device's shared storage UI or a managed install",
  }),
  defineTool({
    name: "adb_pull",
    description: "Copy a remote device file to an approved host path.",
    schema: ToolSchemas.adbPull,
    handler: (args) => H.handleAdbPull(args),
    category: "adb",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT, "The remote path is readable"],
    paths: [path("localPath", "write")],
    tests: [SMOKE, WORKSPACE],
    verification: "npm test — smoke registration and workspace policy tests",
    alternative: null,
  }),
  defineTool({
    name: "adb_rm",
    description: "Recursively delete an absolute remote path under an allowed device scope.",
    schema: ToolSchemas.adbRm,
    handler: (args) => H.handleAdbRm(args),
    category: "adb",
    risk: "destructive",
    policyKey: "device.file.delete",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-delete", "process-spawn"],
    preconditions: [DEVICE, "The target is absolute and inside an allowed scope"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and remote-path validation tests",
    alternative: "Delete the path from the device's file manager with explicit review",
  }),
  defineTool({
    name: "adb_uninstall",
    description: "Uninstall an application package from a device.",
    schema: ToolSchemas.adbUninstall,
    handler: (args) => H.handleAdbUninstall(args),
    category: "adb",
    risk: "destructive",
    policyKey: "device.app.uninstall",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-delete", "process-spawn"],
    preconditions: [DEVICE, "The package is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and package validation tests",
    alternative: "Uninstall through the device settings or Android Studio",
  }),
  defineTool({
    name: "adb_clear_data",
    description: "Clear all application data for a package on a device.",
    schema: ToolSchemas.adbClearData,
    handler: (args) => H.handleAdbClearData(args),
    category: "adb",
    risk: "destructive",
    policyKey: "device.app.clear",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-delete", "process-spawn"],
    preconditions: [DEVICE, "The package is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and package validation tests",
    alternative: "Clear storage from the device's app settings",
  }),
  defineTool({
    name: "adb_force_stop",
    description: "Force-stop an application process on a device.",
    schema: ToolSchemas.adbForceStop,
    handler: (args) => H.handleAdbForceStop(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.app.force_stop",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE, "The package is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and package validation tests",
    alternative: "Stop the app from the device's recent-apps UI",
  }),
  defineTool({
    name: "adb_reboot",
    description: "Reboot a device or emulator and report the command result.",
    schema: ToolSchemas.adbReboot,
    handler: (args) => H.handleAdbReboot(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.reboot",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and reboot handler tests",
    alternative: "Reboot from the device power menu or emulator controls",
  }),
  defineTool({
    name: "adb_screenrecord",
    description:
      "Record the device screen (screenrecord) for a bounded duration and pull the MP4 to the host.",
    schema: ToolSchemas.adbScreenrecord,
    handler: (args) => H.handleAdbScreenrecord(args),
    category: "adb",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-write", "device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT],
    paths: [path("outputPath", "write")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; recording needs a device",
    alternative: null,
  }),
  defineTool({
    name: "adb_input",
    description:
      "Tap the screen, swipe, type text, or send a key event on the device (input injection).",
    schema: ToolSchemas.adbInput,
    handler: (args) => H.handleAdbInput(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.input",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE, "The target screen is in the expected state"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; input injection needs a device",
    alternative: "Use Maestro for a reproducible interaction flow",
  }),
  defineTool({
    name: "adb_deep_link",
    description: "Open a deep-link URI on the device, optionally restricted to a package.",
    schema: ToolSchemas.adbDeepLink,
    handler: (args) => H.handleAdbDeepLink(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE, "An app handles the URI"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and deep-link quoting tests",
    alternative: "Tap the link inside the app or browser",
  }),
  defineTool({
    name: "adb_broadcast",
    description: "Send an explicit broadcast intent with a validated action and quoted extras.",
    schema: ToolSchemas.adbBroadcast,
    handler: (args) => H.handleAdbBroadcast(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE, "The receiving app is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and broadcast validation tests",
    alternative: "Trigger the flow from the app's own test harness",
  }),
  defineTool({
    name: "adb_service_start",
    description: "Start a specific service component with am startservice.",
    schema: ToolSchemas.adbServiceStart,
    handler: (args) => H.handleAdbServiceStart(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE, "The component exists in the target package"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; service start needs a device",
    alternative: "Start the service through the app's own entry point",
  }),
  defineTool({
    name: "adb_wifi",
    description: "Switch adb to TCP/IP, connect to, or disconnect from a network device.",
    schema: ToolSchemas.adbWifi,
    handler: (args) => H.handleAdbWifi(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.network",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "network-egress", "process-spawn"],
    preconditions: [DEVICE, "The host and device share a reachable network for connect"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; wireless adb needs a device",
    alternative: "Pair the device with Android Studio's wireless debugging",
  }),
  defineTool({
    name: "adb_battery",
    description: "Read the device battery status through dumpsys battery.",
    schema: ToolSchemas.adbBattery,
    handler: (args) => H.handleAdbBattery(args),
    category: "adb",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; battery reads need a device",
    alternative: null,
  }),
  defineTool({
    name: "adb_window_geometry",
    description:
      "Read, override or reset Android display size and density (wm size / wm density), with read-back verification.",
    schema: ToolSchemas.adbWindowGeometry,
    handler: (args) => H.handleAdbWindowGeometry(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-write", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE, TOOLS, "test/avd-geometry.test.mjs"],
    verification: "npm test — smoke registration and window geometry handler tests",
    alternative: "Run adb shell wm size and wm density manually",
  }),
  defineTool({
    name: "adb_shell",
    description:
      "Run a raw shell command on a device (shell passthrough); high-trust, arbitrary and not blocklisted.",
    schema: ToolSchemas.adbShell,
    handler: (args) => H.handleAdbShell(args),
    category: "adb",
    risk: "destructive",
    policyKey: "device.shell",
    approval: "expert",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-write", "device-delete", "process-spawn"],
    preconditions: [DEVICE, "The caller has reviewed the exact command"],
    paths: [],
    tests: [SMOKE, TOOLS, "test/outcome.test.mjs"],
    verification: "npm test — smoke registration, handler and outcome tests",
    alternative: "Use a dedicated typed adb_* tool for a known operation",
    timeoutMs: 60_000,
    outputLimitBytes: 40_000,
  }),
  defineTool({
    name: "adb_logcat",
    description: "Clear, wait and dump device logcat with optional tag and regex filtering.",
    schema: ToolSchemas.adbLogcat,
    handler: (args) => H.handleAdbLogcat(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.logs.clear",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-delete", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; logcat capture needs a device",
    alternative: "Read logs without clearing by setting clear:false",
    timeoutMs: 120_000,
    outputLimitBytes: 40_000,
  }),
  defineTool({
    name: "logcat_filtered",
    description: "Clear, wait and return up to 500 logcat lines filtered by tag, package or regex.",
    schema: ToolSchemas.logcatFiltered,
    handler: (args) => H.handleLogcatFiltered(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.logs.clear",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-delete", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; logcat capture needs a device",
    alternative: "Read logs without clearing by setting clear:false",
  }),
  defineTool({
    name: "anr_check",
    description: "Read the device ANR trace file and report whether an ANR marker is present.",
    schema: ToolSchemas.anrCheck,
    handler: (args) => H.handleAnrCheck(args),
    category: "adb",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: [DEVICE, "The ANR trace file is readable on the device"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; ANR reads need a device",
    alternative: null,
  }),
  defineTool({
    name: "crash_summary",
    description: "Clear logcat, observe a bounded window and summarise fatal crash lines.",
    schema: ToolSchemas.crashSummary,
    handler: (args) => H.handleCrashSummary(args),
    category: "adb",
    risk: "device-state",
    policyKey: "device.logs.clear",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-delete", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and crash-summary handler tests",
    alternative: "Collect an existing bug report without clearing logs",
  }),
  defineTool({
    name: "runtime_dump",
    description: "Run structured dumpsys probes for activity, service, package or meminfo.",
    schema: ToolSchemas.runtimeDump,
    handler: (args) => H.handleRuntimeDump(args),
    category: "adb",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and dumpsys output tests",
    alternative: null,
    timeoutMs: 120_000,
    outputLimitBytes: 40_000,
  }),
  defineTool({
    name: "adb_parallel",
    description: "Run an arbitrary shell command on several devices in parallel.",
    schema: ToolSchemas.adbParallel,
    handler: (args) => H.handleAdbParallel(args),
    category: "adb",
    risk: "destructive",
    policyKey: "device.shell",
    approval: "expert",
    unattended: false,
    source: "device",
    sideEffects: ["device-read", "device-write", "device-delete", "process-spawn"],
    preconditions: [DEVICE, "The caller has reviewed the exact command"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and multi-device summary tests",
    alternative: "Call adb_shell per device after reviewing the command",
  }),
  defineTool({
    name: "emulator_list_avds",
    description: "List Android Virtual Devices available to the installed emulator.",
    schema: ToolSchemas.emulatorList,
    handler: () => H.handleEmulatorList(),
    category: "emulator",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["The Android emulator is installed"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; AVD listing needs the emulator",
    alternative: null,
  }),
  defineTool({
    name: "emulator_boot",
    description: "Boot an AVD headless or windowed and wait for Android boot completion.",
    schema: ToolSchemas.emulatorBoot,
    handler: (args) => H.handleEmulatorBoot(args),
    category: "emulator",
    risk: "device-state",
    policyKey: "emulator.boot",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["background-process", "device-write", "host-read"],
    preconditions: [
      "The Android emulator and an AVD are installed",
      "Hardware acceleration is available",
    ],
    paths: [],
    tests: [SMOKE, TOOLS, "test/avd-geometry.test.mjs"],
    verification: "npm test — smoke registration, boot handler and geometry tests",
    alternative: "Start the AVD from Android Studio's Device Manager",
  }),
  defineTool({
    name: "avd_create",
    description: "Create a new Android Virtual Device from a system image and device profile.",
    schema: ToolSchemas.avdCreate,
    handler: (args) => H.handleAvdCreate(args),
    category: "emulator",
    risk: "local-write",
    policyKey: "emulator.create",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["host-write", "external-download", "process-spawn"],
    preconditions: ["avdmanager and the requested system image are installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and AVD name validation tests",
    alternative: null,
  }),
  defineTool({
    name: "avd_delete",
    description: "Delete an Android Virtual Device definition from the host.",
    schema: ToolSchemas.avdDelete,
    handler: (args) => H.handleAvdDelete(args),
    category: "emulator",
    risk: "destructive",
    policyKey: "emulator.delete",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["host-delete", "process-spawn"],
    preconditions: ["The named AVD exists and is stopped"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; deletion is host-dependent",
    alternative: "Delete the AVD from Android Studio's Device Manager",
  }),
  defineTool({
    name: "avd_wipe",
    description:
      "Reset an AVD's user data through a bounded boot, verify boot completion and stop the exact instance.",
    schema: ToolSchemas.avdWipe,
    handler: (args) => H.handleAvdWipe(args),
    category: "emulator",
    risk: "destructive",
    policyKey: "emulator.wipe",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["host-delete", "device-write", "background-process", "process-spawn"],
    preconditions: ["The named AVD exists and is stopped", "The emulator is installed"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and bounded wipe lifecycle tests",
    alternative: "Wipe the AVD from Android Studio's Device Manager",
  }),
  defineTool({
    name: "emulator_snapshot",
    description: "List, save or load an emulator snapshot for a running device.",
    schema: ToolSchemas.emulatorSnapshot,
    handler: (args) => H.handleEmulatorSnapshot(args),
    category: "emulator",
    risk: "device-state",
    policyKey: "emulator.snapshot",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; snapshots need a running emulator",
    alternative: "Manage snapshots from the emulator's extended controls",
  }),
  defineTool({
    name: "frida_ps",
    description: "Ensure frida-server is available and list installed apps and running processes.",
    schema: ToolSchemas.fridaPs,
    handler: (args) => H.handleFridaPs(args),
    category: "frida",
    risk: "device-state",
    policyKey: "frida.server",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "host-read", "process-spawn"],
    preconditions: [
      DEVICE,
      "The frida CLI is installed",
      "The device permits frida-server execution",
    ],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; live Frida needs a device",
    alternative: "List processes with adb_shell ps and attach only when needed",
  }),
  defineTool({
    name: "frida_hook",
    description:
      "Attach or spawn an app and run an inline or file-based Frida hook for a bounded duration.",
    schema: ToolSchemas.fridaHook,
    handler: (args) => H.handleFridaHook(args),
    category: "frida",
    risk: "device-state",
    policyKey: "frida.attach",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "process-spawn"],
    preconditions: [DEVICE, "The frida CLI is installed", WORKSPACE_ROOT],
    paths: [path("scriptPath", "read")],
    tests: [SMOKE, "test/frida.test.mjs"],
    verification: "npm test — smoke registration and Frida script tests",
    alternative: "Use frida_trace_methods for a built-in bounded trace",
  }),
  defineTool({
    name: "frida_trace_methods",
    description:
      "Trace Java methods matching a class and regex, logging arguments and return values.",
    schema: ToolSchemas.fridaTraceMethods,
    handler: (args) => H.handleFridaTraceMethods(args),
    category: "frida",
    risk: "device-state",
    policyKey: "frida.attach",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "process-spawn"],
    preconditions: [DEVICE, "The frida CLI and built-in hook script are installed"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; live tracing needs a device",
    alternative: "Use frida_hook with an explicit reviewed script",
  }),
  defineTool({
    name: "net_capture",
    description:
      "Start or stop a single mitmproxy session, configure the device proxy and write a HAR file.",
    schema: ToolSchemas.netCapture,
    handler: (args) => H.handleNetCapture(args),
    category: "network",
    risk: "network-exposure",
    policyKey: "network.capture",
    approval: "confirmation",
    unattended: false,
    source: "network",
    sideEffects: ["network-listen", "device-write", "host-write", "background-process"],
    preconditions: [DEVICE, "mitmproxy is installed", "The device permits proxy and CA changes"],
    paths: [],
    tests: [SMOKE, "test/net-capture.test.mjs", "test/frida.test.mjs"],
    verification: "npm test — smoke registration and mitmproxy session tests",
    alternative: "Run an external mitmproxy session and configure the device manually",
  }),
  defineTool({
    name: "apk_serve",
    description:
      "Serve staged copies of APK files over loopback HTTP, with explicit LAN-exposure opt-in.",
    schema: ToolSchemas.apkServe,
    handler: (args) => H.handleApkServe(args),
    category: "network",
    risk: "network-exposure",
    policyKey: "network.serve",
    approval: "confirmation",
    unattended: false,
    source: "mcp",
    sideEffects: ["network-listen", "host-read", "background-process", "host-write"],
    preconditions: [WORKSPACE_ROOT, "The chosen directory contains readable .apk files"],
    paths: [path("dir", "read")],
    tests: [SMOKE, TOOLS, WORKSPACE],
    verification: "npm test — smoke registration, staged serving and workspace policy tests",
    alternative: "Serve the APK with a separately managed HTTP server",
  }),
  defineTool({
    name: "ui_dump",
    description: "Dump the current UI hierarchy XML and pull it to an approved host path.",
    schema: ToolSchemas.uiDump,
    handler: (args) => H.handleUiDump(args),
    category: "ui",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-write", "device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT],
    paths: [path("outputPath", "write")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; UI dumps need a device",
    alternative: null,
  }),
  defineTool({
    name: "compose_recomposition",
    description: "Read activity dumpsys output used to inspect Compose recomposition state.",
    schema: ToolSchemas.composeRecomposition,
    handler: (args) => H.handleComposeRecomposition(args),
    category: "ui",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: [DEVICE, "The app under test is running"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and recomposition output tests",
    alternative: null,
  }),
  defineTool({
    name: "layout_bounds",
    description: "Enable or disable the debug.layout property so layout bounds are drawn.",
    schema: ToolSchemas.layoutBounds,
    handler: (args) => H.handleLayoutBounds(args),
    category: "ui",
    risk: "device-state",
    policyKey: "device.state.write",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "process-spawn"],
    preconditions: [DEVICE],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; property changes need a device",
    alternative: "Toggle layout bounds from the device's developer options",
  }),
  defineTool({
    name: "apk_info",
    description: "Read APK badging metadata with aapt2, falling back to a zip listing.",
    schema: ToolSchemas.apkInfo,
    handler: (args) => H.handleApkInfo(args),
    category: "static-analysis",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "static",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["aapt2 or unzip is installed", WORKSPACE_ROOT],
    paths: [path("apkPath", "read")],
    tests: [SMOKE, TOOLS, WORKSPACE],
    verification: "npm test — smoke registration, APK info and workspace policy tests",
    alternative: null,
    timeoutMs: 120_000,
    outputLimitBytes: 12_000,
  }),
  defineTool({
    name: "apk_decompile",
    description:
      "Decompile an APK with jadx or apktool into a new or explicitly replaceable directory.",
    schema: ToolSchemas.apkDecompile,
    handler: (args) => H.handleApkDecompile(args),
    category: "static-analysis",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "static",
    sideEffects: ["host-read", "host-write", "process-spawn"],
    preconditions: ["jadx or apktool is installed", WORKSPACE_ROOT],
    paths: [path("apkPath", "read"), path("outputDir", "write")],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and decompile overwrite tests",
    alternative: null,
    timeoutMs: 600_000,
    outputLimitBytes: 8_000,
  }),
  defineTool({
    name: "manifest_inspect",
    description: "Dump the binary AndroidManifest.xml from an APK as an XML tree.",
    schema: ToolSchemas.manifestInspect,
    handler: (args) => H.handleManifestInspect(args),
    category: "static-analysis",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "static",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["aapt2 is installed", WORKSPACE_ROOT],
    paths: [path("apkPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; manifest inspect needs aapt2",
    alternative: null,
  }),
  defineTool({
    name: "native_libs",
    description: "List native .so libraries packaged in an APK.",
    schema: ToolSchemas.nativeLibs,
    handler: (args) => H.handleNativeLibs(args),
    category: "static-analysis",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "static",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["unzip is installed", WORKSPACE_ROOT],
    paths: [path("apkPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; native library listing needs an APK",
    alternative: null,
  }),
  defineTool({
    name: "dex_strings",
    description: "Extract printable strings from an APK with an optional regex filter.",
    schema: ToolSchemas.dexStrings,
    handler: (args) => H.handleDexStrings(args),
    category: "static-analysis",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "static",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["strings is installed", WORKSPACE_ROOT],
    paths: [path("apkPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; string extraction needs an APK",
    alternative: null,
  }),
  defineTool({
    name: "maestro_run",
    description: "Run a Maestro flow YAML against a connected device.",
    schema: ToolSchemas.maestroRun,
    handler: (args) => H.handleMaestroRun(args),
    category: "testing",
    risk: "device-state",
    policyKey: "device.test.maestro",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "process-spawn"],
    preconditions: [DEVICE, "Maestro is installed", WORKSPACE_ROOT],
    paths: [path("flowPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; Maestro flows need a device",
    alternative: "Run the flow from the Maestro CLI after reviewing it",
  }),
  defineTool({
    name: "instrumented_test",
    description: "Run a module's connected instrumented tests with an optional class filter.",
    schema: ToolSchemas.instrumentedTest,
    handler: (args) => H.handleInstrumentedTest(args),
    category: "testing",
    risk: "device-state",
    policyKey: "device.test.instrumented",
    approval: "confirmation",
    unattended: false,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "device-write", "host-write"],
    preconditions: [GRADLE, DEVICE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; instrumented tests need a device",
    alternative: "Run the test configuration from Android Studio",
  }),
  defineTool({
    name: "test_coverage",
    description: "Run the module's debug unit-test coverage task and return bounded output.",
    schema: ToolSchemas.testCoverage,
    handler: (args) => H.handleTestCoverage(args),
    category: "testing",
    risk: "local-write",
    policyKey: "build.local",
    approval: "none",
    unattended: true,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "host-write"],
    preconditions: [GRADLE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; coverage needs a Gradle project",
    alternative: null,
  }),
  defineTool({
    name: "macrobenchmark",
    description: "Run a module's connected macrobenchmark instrumentation tests.",
    schema: ToolSchemas.macrobenchmark,
    handler: (args) => H.handleMacrobenchmark(args),
    category: "testing",
    risk: "device-state",
    policyKey: "device.test.instrumented",
    approval: "confirmation",
    unattended: false,
    source: "build",
    sideEffects: ["project-build", "process-spawn", "device-write", "host-write"],
    preconditions: [GRADLE, DEVICE, WORKSPACE_ROOT],
    paths: [path("projectPath", "read")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; macrobenchmarks need a device",
    alternative: "Run the benchmark module from Android Studio",
  }),
  defineTool({
    name: "perfetto_trace",
    description: "Capture a Perfetto system trace for a bounded duration and pull it to the host.",
    schema: ToolSchemas.perfettoTrace,
    handler: (args) => H.handlePerfettoTrace(args),
    category: "profiling",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-write", "device-read", "host-write", "process-spawn"],
    preconditions: [DEVICE, WORKSPACE_ROOT],
    paths: [path("outputPath", "write")],
    tests: [SMOKE],
    verification: "npm test — smoke registration; tracing needs a device",
    alternative: null,
  }),
  defineTool({
    name: "memory_profile",
    description: "Read dumpsys meminfo for a package on a device.",
    schema: ToolSchemas.memoryProfile,
    handler: (args) => H.handleMemoryProfile(args),
    category: "profiling",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "device",
    sideEffects: ["device-read", "process-spawn"],
    preconditions: [DEVICE, "The package is installed"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; meminfo reads need a device",
    alternative: null,
  }),
  defineTool({
    name: "startup_time",
    description: "Measure repeated cold-start timings for a package and clean up with force-stop.",
    schema: ToolSchemas.startupTime,
    handler: (args) => H.handleStartupTime(args),
    category: "profiling",
    risk: "device-state",
    policyKey: "device.app.force_stop",
    approval: "confirmation",
    unattended: false,
    source: "device",
    sideEffects: ["device-write", "device-read", "process-spawn"],
    preconditions: [DEVICE, "The package has a resolvable launcher activity"],
    paths: [],
    tests: [SMOKE, TOOLS],
    verification: "npm test — smoke registration and startup timing tests",
    alternative: "Use the Macrobenchmark startup benchmark for repeatable CI metrics",
  }),
  defineTool({
    name: "privacy_scan",
    description:
      "Scan an Android project for privacy inventory signals with explicit evidence classes and scan-coverage limits, then compare them with data-safety declarations. A static inventory aid, not a compliance certificate.",
    schema: ToolSchemas.privacyScan,
    handler: (args) => H.handlePrivacyScan(args),
    category: "privacy",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "project",
    sideEffects: ["host-read", "host-write"],
    preconditions: [WORKSPACE_ROOT, "The project contains an Android manifest and sources"],
    paths: [
      path("projectPath", "read"),
      path("declarationsPath", "read"),
      path("reportPath", "write"),
    ],
    tests: [SMOKE, "test/privacy.test.mjs"],
    verification: "npm test — smoke registration and privacy scanner tests",
    alternative: null,
  }),
  defineTool({
    name: "secret_scan",
    description: "Scan a project tree for committed credentials, redacting every matched value.",
    schema: ToolSchemas.secretScan,
    handler: (args) => H.handleSecretScan(args),
    category: "security",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "project",
    sideEffects: ["host-read", "host-write"],
    preconditions: [WORKSPACE_ROOT, "The project tree is readable"],
    paths: [path("projectPath", "read"), path("reportPath", "write")],
    tests: [SMOKE, "test/policy-preflight.test.mjs"],
    verification: "npm test — smoke registration and secret scanner tests",
    alternative: null,
  }),
  defineTool({
    name: "security_audit",
    description:
      "Audit the source AndroidManifest for exported components and insecure configuration.",
    schema: ToolSchemas.securityAudit,
    handler: (args) => H.handleSecurityAudit(args),
    category: "security",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "project",
    sideEffects: ["host-read", "host-write"],
    preconditions: [WORKSPACE_ROOT, "The project has a source AndroidManifest.xml"],
    paths: [path("projectPath", "read"), path("reportPath", "write")],
    tests: [SMOKE, "test/policy-preflight.test.mjs"],
    verification: "npm test — smoke registration and manifest audit tests",
    alternative: null,
  }),
  defineTool({
    name: "policy_preflight",
    description: "Run a sourced Google Play policy preflight with last-verified policy links.",
    schema: ToolSchemas.policyPreflight,
    handler: (args) => H.handlePolicyPreflight(args),
    category: "security",
    risk: "local-write",
    policyKey: "host.file.write",
    approval: "none",
    unattended: true,
    source: "project",
    sideEffects: ["host-read", "host-write"],
    preconditions: [WORKSPACE_ROOT, "The project has an Android manifest and Gradle build"],
    paths: [path("projectPath", "read"), path("reportPath", "write")],
    tests: [SMOKE, "test/policy-preflight.test.mjs"],
    verification: "npm test — smoke registration and policy preflight tests",
    alternative: null,
  }),
  defineTool({
    name: "android_skills_list",
    description: "List available Android skills through the Android CLI when it is installed.",
    schema: ToolSchemas.skillsList,
    handler: () => H.handleSkillsList(),
    category: "skills",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "mcp",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["The Android CLI is installed for live results"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; live listing needs the Android CLI",
    alternative: null,
  }),
  defineTool({
    name: "android_skills_search",
    description: "Search Android skills through the Android CLI when it is installed.",
    schema: ToolSchemas.skillsSearch,
    handler: (args) => H.handleSkillsSearch(args),
    category: "skills",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "mcp",
    sideEffects: ["host-read", "process-spawn"],
    preconditions: ["The Android CLI is installed for live results"],
    paths: [],
    tests: [SMOKE],
    verification: "npm test — smoke registration; live search needs the Android CLI",
    alternative: null,
  }),
  defineTool({
    name: "tool_catalog",
    description:
      "List registered MCP tools as structured JSON text with category, risk, approval and safe-to-run metadata.",
    schema: ToolSchemas.toolCatalog,
    handler: (args) => handleToolCatalog(args),
    category: "catalog",
    risk: "read-only",
    policyKey: null,
    approval: "none",
    unattended: true,
    source: "mcp",
    sideEffects: ["host-read"],
    preconditions: [],
    paths: [],
    tests: [SMOKE, "test/registry.test.mjs"],
    verification: "npm test — smoke registration and registry catalogue tests",
    alternative: null,
  }),
]);

validateToolRegistry(TOOL_REGISTRY);

/**
 * Path arguments are checked against the workspace policy before handlers run.
 * Derived from the registry so a tool cannot be registered without a recorded
 * path decision (an empty list is an explicit "no filesystem arguments").
 */
export const TOOL_PATH_SPECS: Readonly<Record<string, readonly ToolPathSpec[]>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((entry) => [entry.name, entry.paths])),
);

/** Tool output provenance categories, derived from the registry. */
export const TOOL_SOURCES: Readonly<Record<string, SourceCategory>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((entry) => [entry.name, entry.source])),
);

/** Names only, useful for registration and drift checks. */
export const TOOL_NAMES: readonly string[] = Object.freeze(
  TOOL_REGISTRY.map((entry) => entry.name),
);

/** Direct lookup for the boundary and policy layers. */
export const TOOL_ENTRIES: Readonly<Record<string, ToolDefinition>> = Object.freeze(
  Object.fromEntries(TOOL_REGISTRY.map((entry) => [entry.name, entry])),
);
