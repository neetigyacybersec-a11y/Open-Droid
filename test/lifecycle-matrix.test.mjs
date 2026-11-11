// FR-R22 manifest tests. The checked-in manifest is the contract: every stage
// is covered, complete claims are gated, and the generated table is current.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadManifest, renderCoverage, validateManifest } from "../scripts/lifecycle-matrix.mjs";

const { stages, capabilities, gates } = loadManifest();
const clone = (value) => structuredClone(value);
const errorsFor = (caps, stageList = stages, gateList = gates) =>
  validateManifest(stageList, caps, gateList).join("\n");

test("checked-in manifest is valid", () => {
  assert.deepEqual(validateManifest(stages, capabilities, gates), []);
});

test("unknown stage references fail", () => {
  const caps = clone(capabilities);
  caps[0].stage = "not-a-stage";
  assert.match(errorsFor(caps), /unknown stage not-a-stage/);
});

test("stages without capability rows fail", () => {
  const caps = clone(capabilities).filter((capability) => capability.stage !== "repo-hygiene");
  assert.match(errorsFor(caps), /stage repo-hygiene: no capability row/);
});

test("duplicate capability IDs fail", () => {
  const caps = clone(capabilities);
  caps.push(clone(caps[0]));
  assert.match(errorsFor(caps), /duplicate capability id/);
});

test("complete requires evidence", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.implementation === "complete");
  row.evidence = [];
  assert.match(errorsFor(caps), /complete requires evidence/);
});

test("complete requires an allowlisted gate", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.implementation === "complete");
  row.gate = null;
  assert.match(errorsFor(caps), /complete requires an allowlisted gate/);
});

test("passed verification requires an allowlisted gate", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.verification === "passed");
  row.gate = null;
  assert.match(errorsFor(caps), /passed verification requires an allowlisted gate/);
});

test("not_applicable requires a rationale", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.id === "design-tokens.pipeline");
  row.applicability = "not_applicable";
  assert.match(errorsFor(caps), /not_applicable requires a rationale/);
});

test("conditional requires a condition", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.id === "design-tokens.pipeline");
  row.applicability = "conditional";
  assert.match(errorsFor(caps), /conditional requires a condition/);
});

test("unknown gate IDs fail", () => {
  const caps = clone(capabilities);
  const row = caps.find((capability) => capability.gate === null);
  row.gate = "not-a-gate";
  assert.match(errorsFor(caps), /unknown gate not-a-gate/);
});

test("generated coverage table is current", async () => {
  const current = await readFile(new URL("../docs/lifecycle-coverage.md", import.meta.url), "utf8");
  // Git autocrlf checks this file out with CRLF on Windows runners; the
  // renderer emits LF. Compare normalized so the check is platform-neutral.
  assert.equal(current.replace(/\r\n/g, "\n"), renderCoverage(stages, capabilities));
});
