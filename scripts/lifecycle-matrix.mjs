#!/usr/bin/env node
// FR-R22 lifecycle manifest validator and coverage renderer.
// The manifest is data: gate IDs resolve through manifest/gates.json and are
// never executed from the capabilities file.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COVERAGE_PATH = join(ROOT, "docs", "lifecycle-coverage.md");

const APPLICABILITY = new Set(["required", "conditional", "optional", "not_applicable"]);
const IMPLEMENTATION = new Set(["missing", "partial", "complete"]);
const VERIFICATION = new Set(["untested", "passed", "failed"]);

const isText = (value) => typeof value === "string" && value.trim().length > 0;

export function loadManifest(root = ROOT) {
  const read = (name) => JSON.parse(readFileSync(join(root, "manifest", name), "utf8"));
  return {
    stages: read("stages.json"),
    capabilities: read("capabilities.json"),
    gates: read("gates.json"),
  };
}

export function validateManifest(stages, capabilities, gates) {
  const errors = [];
  if (!Array.isArray(stages)) {
    return ["stages.json: expected an array"];
  }
  if (!Array.isArray(capabilities)) {
    return ["capabilities.json: expected an array"];
  }
  if (gates === null || typeof gates !== "object" || Array.isArray(gates)) {
    return ["gates.json: expected an object keyed by gate ID"];
  }

  const stageIds = new Set();
  for (const [index, stage] of stages.entries()) {
    const where = `stages[${index}]`;
    if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
      errors.push(`${where}: expected an object`);
      continue;
    }
    if (!isText(stage.id)) {
      errors.push(`${where}: id is required`);
    } else if (stageIds.has(stage.id)) {
      errors.push(`${where}: duplicate stage id ${stage.id}`);
    } else {
      stageIds.add(stage.id);
    }
    if (!isText(stage.name)) errors.push(`${where}: name is required`);
  }

  const capabilityIds = new Set();
  const coveredStages = new Set();
  for (const [index, capability] of capabilities.entries()) {
    const where = `capabilities[${index}]${isText(capability?.id) ? ` (${capability.id})` : ""}`;
    if (capability === null || typeof capability !== "object" || Array.isArray(capability)) {
      errors.push(`${where}: expected an object`);
      continue;
    }
    if (!isText(capability.id)) {
      errors.push(`${where}: id is required`);
    } else if (capabilityIds.has(capability.id)) {
      errors.push(`${where}: duplicate capability id ${capability.id}`);
    } else {
      capabilityIds.add(capability.id);
    }

    if (!isText(capability.stage)) {
      errors.push(`${where}: stage is required`);
    } else if (!stageIds.has(capability.stage)) {
      errors.push(`${where}: unknown stage ${capability.stage}`);
    } else {
      coveredStages.add(capability.stage);
    }

    if (!APPLICABILITY.has(capability.applicability)) {
      errors.push(`${where}: invalid applicability ${JSON.stringify(capability.applicability)}`);
    }
    if (!IMPLEMENTATION.has(capability.implementation)) {
      errors.push(`${where}: invalid implementation ${JSON.stringify(capability.implementation)}`);
    }
    if (!VERIFICATION.has(capability.verification)) {
      errors.push(`${where}: invalid verification ${JSON.stringify(capability.verification)}`);
    }

    if (!Array.isArray(capability.evidence)) {
      errors.push(`${where}: evidence must be an array`);
    } else {
      for (const entry of capability.evidence) {
        if (!isText(entry)) errors.push(`${where}: evidence entries must be non-empty strings`);
      }
    }

    if (capability.gate !== null && capability.gate !== undefined) {
      if (!isText(capability.gate)) {
        errors.push(`${where}: gate must be a string or null`);
      } else if (!Object.hasOwn(gates, capability.gate)) {
        errors.push(`${where}: unknown gate ${capability.gate}`);
      }
    }

    if (capability.applicability === "not_applicable" && !isText(capability.rationale)) {
      errors.push(`${where}: not_applicable requires a rationale`);
    }
    if (capability.applicability === "conditional" && !isText(capability.condition)) {
      errors.push(`${where}: conditional requires a condition`);
    }
    if (capability.implementation === "complete" && capability.applicability !== "not_applicable") {
      if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
        errors.push(`${where}: complete requires evidence`);
      }
      if (!isText(capability.gate)) {
        errors.push(`${where}: complete requires an allowlisted gate`);
      }
    }
    if (capability.verification === "passed" && !isText(capability.gate)) {
      errors.push(`${where}: passed verification requires an allowlisted gate`);
    }
  }

  for (const stageId of stageIds) {
    if (!coveredStages.has(stageId)) errors.push(`stage ${stageId}: no capability row`);
  }

  for (const [gateId, gate] of Object.entries(gates)) {
    const where = `gates.${gateId}`;
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      errors.push(`${where}: expected an object`);
      continue;
    }
    if (!isText(gate.description)) errors.push(`${where}: description is required`);
    if (!isText(gate.workflow)) errors.push(`${where}: workflow is required`);
    if (!isText(gate.job)) errors.push(`${where}: job is required`);
    if (!isText(gate.command)) errors.push(`${where}: command is required`);
  }

  return errors;
}

const escapeCell = (value) => String(value).replaceAll("|", "\\|");
const orDash = (value) => (isText(value) ? value : "—");

export function renderCoverage(stages, capabilities) {
  const order = new Map(stages.map((stage, index) => [stage.id, index]));
  const stageNames = new Map(stages.map((stage) => [stage.id, stage.name]));
  const sorted = [...capabilities].sort((left, right) => {
    const leftOrder = order.get(left.stage) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.stage) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });

  const complete = sorted.filter((capability) => capability.implementation === "complete").length;
  const gated = sorted.filter((capability) => isText(capability.gate)).length;
  const lines = [
    "<!-- Generated by `node scripts/lifecycle-matrix.mjs --write` from manifest/stages.json and manifest/capabilities.json. Do not edit by hand. -->",
    "",
    "# Lifecycle coverage",
    "",
    `${stages.length} stages · ${sorted.length} capability rows · ${complete} complete · ${gated} gated.`,
    "",
    "`complete` requires inspectable evidence and an allowlisted gate; `conditional` rows state when they apply.",
    "",
    "Applicability reflects the reference product scope in `BACKLOG.md`; a product manifest narrows it with `conditional` or `not_applicable` rows.",
    "",
    "| Stage | Capability | Applicability | Implementation | Verification | Gate | Condition / rationale | Evidence |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const capability of sorted) {
    const condition =
      capability.applicability === "conditional"
        ? capability.condition
        : capability.applicability === "not_applicable"
          ? capability.rationale
          : null;
    const evidence = Array.isArray(capability.evidence) && capability.evidence.length > 0
      ? capability.evidence.map((entry) => `\`${entry}\``).join("<br>")
      : "—";
    lines.push(
      `| ${escapeCell(stageNames.get(capability.stage) ?? capability.stage)} | \`${capability.id}\` | ${capability.applicability} | ${capability.implementation} | ${capability.verification} | ${capability.gate ? `\`${capability.gate}\`` : "—"} | ${escapeCell(orDash(condition))} | ${evidence} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const write = argv.includes("--write");
  const check = argv.includes("--check") || !write;
  const { stages, capabilities, gates } = loadManifest();
  const errors = validateManifest(stages, capabilities, gates);

  if (errors.length > 0) {
    console.error(`lifecycle manifest: ${errors.length} error(s)`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const markdown = renderCoverage(stages, capabilities);
  if (write) {
    writeFileSync(COVERAGE_PATH, markdown);
    console.log("wrote docs/lifecycle-coverage.md");
  }

  if (check) {
    let current = null;
    try {
      current = readFileSync(COVERAGE_PATH, "utf8");
    } catch {
      current = null;
    }
    if (current !== markdown) {
      console.error("lifecycle manifest: docs/lifecycle-coverage.md is stale; run node scripts/lifecycle-matrix.mjs --write");
      process.exitCode = 1;
      return;
    }
    const complete = capabilities.filter((capability) => capability.implementation === "complete").length;
    const gated = capabilities.filter((capability) => isText(capability.gate)).length;
    console.log(
      `lifecycle manifest OK: ${stages.length} stages, ${capabilities.length} capabilities, ${complete} complete, ${gated} gated`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
