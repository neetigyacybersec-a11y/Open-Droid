// ISSUE-150: doctor JSON, schema, capability semantics and conservative repair.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { collectDoctor, DOCTOR_SCHEMA, formatDoctor } from "../scripts/installer/doctor.mjs";
import { readManifest, writeManifest } from "../scripts/installer/manifest.mjs";
import { repairPlan, runRepair } from "../scripts/repair.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "doctor-"));
test.after(() => rmSync(work, { recursive: true, force: true }));
const schema = JSON.parse(readFileSyncText(join(REPO, "install", "doctor.schema.json")));
function readFileSyncText(path) {
  return readFileSyncLocal(path);
}
import { readFileSync as readFileSyncLocal } from "node:fs";

function validate(instance, definition, path = "$") {
  if (definition.const !== undefined) assert.equal(instance, definition.const, path);
  if (definition.enum) assert.ok(definition.enum.includes(instance), `${path}: ${instance}`);
  const types = definition.type ? [].concat(definition.type) : [];
  if (types.length) {
    const actual = Array.isArray(instance) ? "array" : instance === null ? "null" : typeof instance;
    assert.ok(types.includes(actual) || (actual === "object" && types.includes("object")), `${path}: ${actual}`);
  }
  if (definition.properties && typeof instance === "object" && instance !== null) {
    for (const required of definition.required ?? []) assert.ok(required in instance, `${path}.${required}`);
    if (definition.additionalProperties === false) {
      for (const key of Object.keys(instance)) assert.ok(key in definition.properties, `${path}.${key} is not in the schema`);
    }
    for (const [key, child] of Object.entries(definition.properties)) {
      if (key in instance) validate(instance[key], child, `${path}.${key}`);
    }
  }
  if (definition.items && Array.isArray(instance)) {
    instance.forEach((item, index) => validate(item, definition.items, `${path}[${index}]`));
  }
}

function lookupFound(name) {
  return ["/bin/true", null][0];
}
test("doctor JSON validates against the committed schema", () => {
  const root = join(work, "repo");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "tool-catalogue.md"),
    "| `adb_install` | `gradle_task` | `apk_info` |\n",
  );
  const report = collectDoctor({
    root,
    platform: "linux",
    lookup: (name) => (name === "adb" ? "/bin/true" : null),
  });
  assert.equal(report.schema, DOCTOR_SCHEMA);
  validate(report, schema);
  assert.equal(report.device.status, "absent");
  assert.ok(report.registeredTools.includes("gradle_task"));
  assert.ok(!report.runnableTools.includes("gradle_task"));
  assert.match(formatDoctor(report), /registered tools: \d+; runnable: \d+/);
});

test("managed executables are found even when absent from PATH", () => {
  const root = join(work, "managed-repo");
  const installRoot = join(root, ".toolchain");
  mkdirSync(join(installRoot, "bin"), { recursive: true });
  writeFileSync(join(installRoot, "bin", "gradle"), "#!/bin/sh\n");
  writeManifest(installRoot, {
    schema: 1,
    profile: "core",
    components: { gradle: { required: true, paths: ["bin/gradle"] } },
  });
  const report = collectDoctor({ root, installRoot, platform: "linux", lookup: () => null });
  const gradle = report.capabilities.find((c) => c.id === "gradle");
  assert.equal(gradle.status, "path-only");
  assert.equal(gradle.managed, join(installRoot, "bin", "gradle"));
  assert.equal(gradle.provenance, "managed");
  assert.match(gradle.diagnostic, /not on PATH/);
  assert.ok(report.summary.missing.includes("gradle"));
});

test("a malformed or missing manifest degrades to host-only checks", () => {
  const root = join(work, "no-manifest");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "install-manifest.json"), "{ not json");
  const report = collectDoctor({ root, platform: "linux", lookup: () => null });
  assert.equal(report.installation.manifestPresent, false);
  assert.equal(readManifest(root), null);
  assert.equal(report.summary.ok, false);
});

test("repair is dry-run by default, named and confirmed before mutation", async () => {
  const report = collectDoctor({
    root: work,
    platform: "linux",
    lookup: (name) => (name === "node" ? "/bin/true" : null),
  });
  const plan = repairPlan(report, "gradle");
  assert.ok(plan.some((stage) => stage.stage === "reinstall"));
  const preview = await runRepair({ component: "gradle", report, install: async () => ({ ok: true }) });
  assert.equal(preview.dryRun, true);
  assert.ok(preview.results.every((r) => r.status === "planned" || r.status === "manual"));
  await assert.rejects(
    () => runRepair({ component: "gradle", dryRun: false, report, install: async () => ({}) }),
    /requires --yes/,
  );
  await assert.rejects(
    () => runRepair({ component: "unknown", report, install: async () => ({}) }),
    /unknown component/,
  );
  const applied = await runRepair({
    component: "gradle",
    dryRun: false,
    yes: true,
    report,
    install: async (options) => {
      assert.equal(options.capabilities[1], "gradle");
      return { changed: true };
    },
  });
  assert.ok(applied.results.some((r) => r.stage === "reinstall" && r.status === "done"));
});

test("a failed repair stage is reported and stops subsequent stages", async () => {
  const report = collectDoctor({ root: work, platform: "linux", lookup: () => null });
  const result = await runRepair({
    component: "jadx",
    dryRun: false,
    yes: true,
    report,
    install: async () => {
      throw new Error("download failed");
    },
  });
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].detail, /download failed/);
});
