// ISSUE-104: one typed registry is the source of truth for registration,
// risk policy, path policy, provenance and test coverage. Completeness must be
// enforced, not documented: a tool without a schema, handler, risk class,
// approval requirement or test reference cannot be registered.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  IMPACT_CLASSES,
  PLANNED_TOOLS,
  TOOL_CATEGORIES,
  TOOL_PATH_SPECS,
  TOOL_REGISTRY,
  TOOL_SOURCES,
  baseImpact,
  filterToolCatalog,
  handleToolCatalog,
  validateToolRegistry,
} from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RISKS = [
  "read-only",
  "local-write",
  "device-state",
  "destructive",
  "network-exposure",
  "external-write",
];
const APPROVALS = ["none", "confirmation", "expert"];
const base = TOOL_REGISTRY.find((entry) => entry.name === "android_env_check");
if (!base) throw new Error("registry is missing android_env_check");

const clone = (overrides) => ({ ...base, ...overrides });

function rejects(entries, pattern) {
  assert.throws(() => validateToolRegistry(entries), pattern);
}

test("registry names are unique and every entry has one schema and handler", () => {
  assert.equal(TOOL_REGISTRY.length, 68, "adding or removing a tool requires a deliberate registry edit");
  const names = TOOL_REGISTRY.map((entry) => entry.name);
  assert.equal(new Set(names).size, names.length, "registry names must be unique");
  for (const entry of TOOL_REGISTRY) {
    assert.match(entry.name, /^[a-z][a-z0-9_]*$/, entry.name);
    assert.equal(typeof entry.schema?.safeParse, "function", `${entry.name} has no schema`);
    assert.equal(typeof entry.handler, "function", `${entry.name} has no handler`);
    assert.ok(entry.description.trim().length >= 20, `${entry.name} needs a useful description`);
    assert.ok(TOOL_CATEGORIES.includes(entry.category), `${entry.name} has an unknown category`);
  }
});

test("every published schema belongs to exactly one registry entry", () => {
  const counts = new Map();
  for (const entry of TOOL_REGISTRY) {
    counts.set(entry.schema, (counts.get(entry.schema) ?? 0) + 1);
  }
  for (const [entry, count] of counts) {
    assert.equal(count, 1, `${entry.name ?? "schema"} is shared by ${count} tools`);
  }
  for (const [key, schema] of Object.entries(ToolSchemas)) {
    assert.equal(counts.get(schema), 1, `ToolSchemas.${key} is not owned by one tool`);
  }
  assert.equal(counts.size, Object.keys(ToolSchemas).length);
});

test("every safety-relevant field is explicit, never defaulted", () => {
  for (const entry of TOOL_REGISTRY) {
    assert.ok(RISKS.includes(entry.risk), `${entry.name} risk`);
    assert.ok(IMPACT_CLASSES.includes(baseImpact(entry)), `${entry.name} impact`);
    assert.ok(APPROVALS.includes(entry.approval), `${entry.name} approval`);
    assert.equal(typeof entry.unattended, "boolean", `${entry.name} unattended`);
    assert.ok(Array.isArray(entry.sideEffects), `${entry.name} sideEffects`);
    assert.ok(Array.isArray(entry.preconditions), `${entry.name} preconditions`);
    assert.ok(Array.isArray(entry.paths), `${entry.name} paths`);
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${entry.name} tests`);
    assert.ok(entry.verification.trim().length > 0, `${entry.name} verification`);
    assert.match(entry.source, /^(project|build|device|static|network|mixed|mcp)$/, entry.name);
    if (entry.risk === "read-only") {
      assert.equal(entry.policyKey, null, `${entry.name} read-only tools have no policy key`);
    } else {
      assert.match(entry.policyKey ?? "", /^[a-z][a-z0-9_.]*$/, `${entry.name} policy key`);
    }
    if (["destructive", "network-exposure", "external-write"].includes(entry.risk)) {
      assert.notEqual(entry.approval, "none", `${entry.name} must require approval`);
      assert.equal(entry.unattended, false, `${entry.name} must not run unattended`);
    }
    if (entry.risk === "device-state") {
      assert.notEqual(entry.approval, "none", `${entry.name} changes device state`);
    }
  }
});

test("validation rejects duplicate names", () => {
  rejects([clone({ name: "duplicate_tool" }), clone({ name: "duplicate_tool" })], /duplicate tool name/);
});

test("validation rejects missing schema, handler or description", () => {
  rejects([clone({ schema: undefined })], /schema/);
  rejects([clone({ handler: undefined })], /handler/);
  rejects([clone({ description: "short" })], /description/);
  rejects([clone({ sideEffects: undefined })], /sideEffects/);
  rejects([clone({ preconditions: undefined })], /preconditions/);
  rejects([clone({ paths: undefined })], /paths/);
  rejects([clone({ source: undefined })], /source/);
  rejects([clone({ timeoutMs: 0 })], /timeoutMs/);
  rejects([clone({ outputLimitBytes: -1 })], /outputLimitBytes/);
});

test("validation rejects safety-sensitive tools without policy or approval", () => {
  rejects([clone({ name: "unsafe_write", risk: "local-write", policyKey: null })], /policy key/);
  rejects(
    [clone({ name: "unsafe_delete", risk: "destructive", policyKey: "device.destructive", approval: "none" })],
    /approval/,
  );
  rejects(
    [clone({ name: "unsafe_network", risk: "network-exposure", policyKey: "network.expose", unattended: true })],
    /unattended/,
  );
});

test("a new destructive tool cannot masquerade as read-only or unattended", () => {
  rejects([clone({ name: "unsafe_default", risk: undefined })], /risk/);
  rejects([clone({ name: "unsafe_default", risk: "destructive", approval: "none", unattended: true })], /approval|unattended/);
});

test("representative tools are classified by impact", () => {
  const byName = (name) => TOOL_REGISTRY.find((entry) => entry.name === name);
  assert.equal(byName("android_env_check").risk, "read-only");
  assert.equal(byName("android_env_check").approval, "none");
  assert.equal(byName("adb_screenshot").risk, "local-write");
  assert.equal(byName("adb_launch").risk, "device-state");
  assert.equal(byName("adb_rm").risk, "destructive");
  assert.equal(byName("adb_rm").approval, "confirmation");
  assert.equal(byName("adb_rm").unattended, false);
  assert.equal(byName("sdkmanager_install").risk, "external-write");
  assert.equal(byName("sdkmanager_install").unattended, false);
  assert.equal(byName("apk_serve").risk, "network-exposure");
  assert.equal(byName("apk_serve").unattended, false);
  assert.equal(byName("gradle_task").risk, "destructive");
  assert.equal(byName("tool_catalog").risk, "read-only");
});

test("safe catalogue hides every state-changing tool and groups deterministically", () => {
  const entries = filterToolCatalog({ safeOnly: true });
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.approval, "none", `${entry.name} is not approval-free`);
    assert.equal(entry.unattended, true, `${entry.name} is not unattended-safe`);
    assert.ok(["read-only", "local-write"].includes(entry.risk), `${entry.name} risk`);
  }
  for (const name of ["adb_rm", "adb_shell", "adb_launch", "sdkmanager_install", "apk_serve"]) {
    assert.ok(!entries.some((entry) => entry.name === name), `${name} must not appear in the safe view`);
  }
  assert.deepEqual(filterToolCatalog({ safeOnly: true }), entries);
});

test("catalogue handler returns filtered JSON and rejects unknown filters", async () => {
  const result = await handleToolCatalog({ safeOnly: true, category: "adb" });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.safeOnly, true);
  assert.ok(Array.isArray(payload.groups));
  assert.equal(payload.riskSummary.destructive, 0);
  for (const group of payload.groups) {
    assert.equal(group.category, "adb");
    for (const tool of group.tools) {
      assert.notEqual(tool.risk, "destructive");
      assert.ok(IMPACT_CLASSES.includes(tool.impact), `${tool.name} impact`);
    }
  }
  const invalid = await handleToolCatalog({ category: "not-a-category" });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /unknown category/);
});

test("every test reference exists and every risk class has real coverage", () => {
  const referenced = new Set();
  for (const entry of TOOL_REGISTRY) {
    for (const relative of entry.tests) {
      assert.ok(existsSync(join(REPO, relative)), `${entry.name} references missing ${relative}`);
      referenced.add(relative);
    }
  }
  assert.ok(referenced.size >= 5, "test inventory must span more than one file");
});

test("path and provenance metadata are derived from the full catalogue", () => {
  assert.deepEqual(Object.keys(TOOL_PATH_SPECS).sort(), TOOL_REGISTRY.map((entry) => entry.name).sort());
  assert.deepEqual(Object.keys(TOOL_SOURCES).sort(), TOOL_REGISTRY.map((entry) => entry.name).sort());
  assert.deepEqual(TOOL_PATH_SPECS.tool_catalog, []);
  assert.equal(TOOL_SOURCES.tool_catalog, "mcp");
});

test("test inventory is generated from the registry and flags thin coverage", () => {
  const result = spawnSync(process.execPath, ["scripts/tool-catalogue.mjs", "--test-inventory"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n");
  assert.equal(rows.length, TOOL_REGISTRY.length);
  const names = new Set(rows.map((row) => row.split("\t")[0]));
  assert.deepEqual([...names].sort(), TOOL_REGISTRY.map((entry) => entry.name).sort());
  for (const row of rows) {
    assert.match(row, /\t(referenced|registration-only)\t/);
  }
  assert.ok(
    rows.some((row) => row.includes("\tregistration-only\t")),
    "the inventory must report tools whose only reference is the smoke test",
  );
});

test("generated catalogue documentation is current", () => {
  const result = spawnSync(process.execPath, ["scripts/tool-catalogue.mjs", "--check"], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("planned tools are explicit, tracked and never registered", () => {
  const registered = new Set(TOOL_REGISTRY.map((entry) => entry.name));
  assert.deepEqual(
    PLANNED_TOOLS.map((tool) => tool.name).sort(),
    ["a11y_audit", "design_qa_matrix", "screenshot_diff"],
    "the planned list is the checked-in answer for names that docs may mention",
  );
  for (const tool of PLANNED_TOOLS) {
    assert.equal(tool.status, "not-implemented", tool.name);
    assert.ok(tool.summary.trim().length >= 20, `${tool.name} needs a useful summary`);
    assert.ok(tool.tracking.length > 0, `${tool.name} needs a tracking issue`);
    assert.ok(!registered.has(tool.name), `${tool.name} is planned and must not be registered`);
  }
});

test("README and generated catalogue mark planned tools as unavailable", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const catalogue = readFileSync(join(REPO, "docs", "tool-catalogue.md"), "utf8");
  assert.match(readme, /\*\*Not registered:\*\*/);
  assert.match(catalogue, /## Output content/);
  assert.match(catalogue, /Every registered tool returns MCP text content/);
  assert.match(catalogue, /`adb_screenshot` and[\s\S]*`compose_preview_render`/);
  assert.match(catalogue, /No tool returns an MCP resource or embedded file/);
  assert.match(catalogue, /## Planned, not registered/);
  for (const tool of PLANNED_TOOLS) {
    assert.ok(readme.includes(`\`${tool.name}\``), `README must name planned tool ${tool.name}`);
    assert.ok(
      catalogue.includes(`| \`${tool.name}\` | \`not-implemented\` |`),
      `catalogue must mark ${tool.name} as not implemented`,
    );
    for (const issue of tool.tracking) {
      assert.ok(catalogue.includes(`#${issue}`), `catalogue must link ${tool.name} to #${issue}`);
    }
  }
});

test("README category counts match the registry", () => {
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const labels = {
    Environment: "environment",
    Build: "build",
    ADB: "adb",
    "Emulator / AVD": "emulator",
    "Frida (dynamic)": "frida",
    "Network exposure": "network",
    "UI inspection": "ui",
    "Static analysis": "static-analysis",
    Testing: "testing",
    Profiling: "profiling",
    Privacy: "privacy",
    Security: "security",
    Skills: "skills",
    Catalogue: "catalog",
  };
  let total = 0;
  for (const [label, category] of Object.entries(labels)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = readme.match(new RegExp(`^\\| ${escaped} \\| (\\d+) \\|`, "m"));
    assert.ok(match, `README is missing the ${label} category row`);
    const expected = TOOL_REGISTRY.filter((entry) => entry.category === category).length;
    assert.equal(Number(match[1]), expected, `README ${label} count drifted`);
    total += Number(match[1]);
  }
  assert.equal(total, TOOL_REGISTRY.length, "README category counts must sum to the registry size");
});

test("descriptions name the non-text content a caller receives", () => {
  const byName = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]));
  assert.match(byName.get("adb_screenshot").description, /image content/);
  assert.match(byName.get("compose_preview_render").description, /inline images/);
  assert.match(byName.get("tool_catalog").description, /structured JSON text/);
  assert.match(
    readFileSync(join(REPO, "docs", "tool-catalogue.md"), "utf8"),
    /No tool returns an MCP resource or embedded file/,
  );
});
