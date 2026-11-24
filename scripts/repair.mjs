#!/usr/bin/env node
// ISSUE-150: conservative repair. Dry-run by default, named components only,
// explicit confirmation, per-stage results. Never edits projects or Git state.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectDoctor } from "./installer/doctor.mjs";
import { runInstall } from "./install.mjs";
import { buildState } from "./build-state.mjs";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const COMPONENTS = {
  java: "java",
  node: null,
  gradle: "gradle",
  aapt2: "android-sdk",
  "android-sdk": "android-sdk",
  jadx: "jadx",
  apktool: "apktool",
  compose_preview: "compose-preview",
  compose_preview_render: "compose-preview",
  maestro: "maestro",
  frida: "frida",
  mitmdump: "frida",
};

export function repairPlan(report, component) {
  const stages = [];
  const capability = report.capabilities.find((c) => c.id === component);
  if (capability?.status === "path-only") {
    stages.push({
      stage: "environment",
      action: "source .toolchain/env.sh (or set PATH/JAVA_HOME in .toolchain/env.ps1)",
      safe: true,
    });
  } else if (capability && capability.status !== "ok" && COMPONENTS[component]) {
    stages.push({
      stage: "reinstall",
      component: COMPONENTS[component],
      action: `node scripts/install.mjs --profile custom --capabilities no-core,${COMPONENTS[component]}`,
      safe: true,
    });
  }
  if (buildState(REPO).state !== "current") {
    stages.push({ stage: "build", action: "npm run build", safe: true });
  }
  return stages;
}

export async function runRepair({
  component,
  dryRun = true,
  yes = false,
  report = collectDoctor(),
  install = runInstall,
  exec = (command, args) =>
    spawnSync(command, args, { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" }),
} = {}) {
  if (!component) throw new Error("repair requires --component <id>");
  if (!report.capabilities.some((c) => c.id === component)) {
    throw new Error(`unknown component: ${component}`);
  }
  const stages = repairPlan(report, component);
  if (stages.length === 0) return { component, dryRun, stages: [], results: [], message: "healthy; nothing to repair" };
  if (!dryRun && !yes) throw new Error("repair requires --yes to apply changes (dry run is the default)");
  const results = [];
  for (const stage of stages) {
    if (dryRun) {
      results.push({ stage: stage.stage, status: "planned", detail: stage.action });
      continue;
    }
    try {
      if (stage.stage === "reinstall") {
        await install({
          profile: "custom",
          capabilities: ["no-core", stage.component],
          root: resolve(REPO, ".toolchain"),
        });
      } else if (stage.stage === "build") {
        exec(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
      } else {
        results.push({ stage: stage.stage, status: "manual", detail: stage.action });
        continue;
      }
      results.push({ stage: stage.stage, status: "done", detail: stage.action });
    } catch (error) {
      results.push({ stage: stage.stage, status: "failed", detail: error.message });
      break;
    }
  }
  return { component, dryRun, stages, results };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const result = await runRepair({
    component: value("--component"),
    dryRun: !argv.includes("--yes"),
    yes: argv.includes("--yes"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.results.some((r) => r.status === "failed") ? 1 : 0;
}
