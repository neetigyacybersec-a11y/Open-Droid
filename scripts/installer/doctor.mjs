// ISSUE-150: one checker behind both human and JSON doctor output. A tool is
// "registered" only in the catalogue; it is runnable only when its executable
// resolves. Managed components are found even when absent from PATH.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildState } from "../build-state.mjs";
import { componentCatalog, readPins } from "./profiles.mjs";
import { readManifest } from "./manifest.mjs";
import { inspectClient, SUPPORTED_CLIENTS } from "../clients.mjs";

export const DOCTOR_SCHEMA = 1;

function which(name, env = process.env, platform = process.platform) {
  const command = platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8", env });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function versionOf(path, platform) {
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      shell: platform === "win32" && /\.(bat|cmd)$/i.test(path),
    });
    return ((result.stdout || result.stderr || "").split(/\r?\n/).find(Boolean) ?? "").slice(0, 120) || null;
  } catch {
    return null;
  }
}

function registeredTools(root) {
  try {
    const text = readFileSync(join(root, "docs", "tool-catalogue.md"), "utf8");
    return [...new Set([...text.matchAll(/`(adb_install|gradle_task|apk_info|apk_decompile|compose_preview_render|android_skills_search|frida_ps|net_capture|maestro_run|android_env_check)`/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

function registrationStatus(repo, env, platform) {
  const clients = SUPPORTED_CLIENTS.map((client) =>
    inspectClient(client, { home: env.HOME ?? env.USERPROFILE ?? "/tmp", project: repo, platform }),
  );
  const supported = clients.filter((client) => client.supported);
  const registered = supported.filter((client) => client.registered);
  return {
    status: registered.length === 0 ? "missing" : registered.some((client) => client.stale) ? "drift" : "ok",
    clients: registered.map((client) => `${client.client}:${client.scope}`),
    restartRequired: registered.some((client) => client.restartRequired),
  };
}

/** Collect a versioned health report. Pure enough to use from tests. */
export function collectDoctor({
  root = resolve(fileURLToPath(new URL("../../", import.meta.url))),
  installRoot,
  platform = process.platform,
  env = process.env,
  lookup = which,
} = {}) {
  const repo = resolve(root);
  const target = installRoot ?? join(repo, ".toolchain");
  const manifest = readManifest(target);
  let pins = {};
  try {
    pins = readPins(repo);
  } catch {
    // A fixture or partial install has no pins; capabilities still report.
  }
  const catalog = componentCatalog(pins);
  const capabilities = [];
  const probes = { node: "node", java: "java", gradle: "gradle", aapt2: "aapt2", jadx: "jadx", apktool: "apktool", compose_preview: "compose-preview", android_cli: "android", maestro: "maestro", frida: "frida", mitmdump: "mitmdump" };
  for (const [id, command] of Object.entries(probes)) {
    const spec = catalog[id] ?? {};
    const onPath = lookup(command, env, platform);
    const owned = manifest?.components?.[id]?.paths?.[0];
    const managed = owned ? resolve(target, owned) : null;
    const managedExists = managed ? existsSync(managed) : false;
    const path = onPath ?? (managedExists ? managed : null);
    let status = "missing";
    if (onPath) status = "ok";
    else if (managedExists) status = "path-only";
    else if (spec.optional || id === "android_cli" || id === "frida" || id === "mitmdump") status = "optional-missing";
    capabilities.push({
      id,
      label: spec.label ?? id,
      required: Boolean(manifest?.components?.[id]?.required ?? !spec.optional),
      status,
      path,
      onPath,
      managed: managedExists ? managed : null,
      version: path && !path.includes(" ") ? versionOf(path, platform) : null,
      provenance: onPath ? "host" : managedExists ? "managed" : "none",
      diagnostic:
        status === "path-only"
          ? "managed executable exists but is not on PATH; source .toolchain/env.sh or use the managed path"
          : status === "missing"
            ? `${command} not found on PATH or in the managed installation`
            : null,
    });
  }
  const build = buildState(repo);
  const registered = registeredTools(repo);
  const device = {
    status: "absent",
    adb: lookup("adb", env, platform),
    emulator: lookup("emulator", env, platform),
    diagnostic: "device/emulator availability is checked separately from core installation health",
  };
  const missing = capabilities.filter((c) => c.required && (c.status === "missing" || c.status === "path-only")).map((c) => c.id);
  return {
    schema: DOCTOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    platform: { os: platform, arch: process.arch },
    installation: {
      root: target,
      profile: manifest?.profile ?? null,
      version: manifest?.version ?? null,
      sourceCommit: manifest?.sourceCommit ?? null,
      manifestPresent: Boolean(manifest),
    },
    build: { state: build.state, detail: build.detail },
    capabilities,
    registeredTools: registered,
    runnableTools: registered.filter((name) => {
      const mapping = { adb_install: "adb", gradle_task: "gradle", apk_info: "aapt2", apk_decompile: "jadx", compose_preview_render: "compose-preview", android_skills_search: "android", frida_ps: "frida", net_capture: "mitmdump", maestro_run: "maestro" };
      return mapping[name] ? capabilities.some((c) => c.id === mapping[name] && c.status === "ok") : false;
    }),
    device,
    registration: registrationStatus(repo, env, platform),
    summary: {
      ok: missing.length === 0 && build.state === "current",
      missing,
      unavailable: capabilities.filter((c) => c.status.startsWith("optional")).map((c) => c.id),
    },
  };
}

/** Human rendering shares the exact report used by --json. */
export function formatDoctor(report) {
  const lines = [
    `doctor schema ${report.schema} — ${report.platform.os}/${report.platform.arch}`,
    `install: ${report.installation.profile ?? "unknown"} at ${report.installation.root}`,
    `build ${report.build.state}: ${report.build.detail}`,
    "capabilities:",
  ];
  for (const capability of report.capabilities) {
    lines.push(
      `  ${capability.id}: ${capability.status}${capability.path ? ` -> ${capability.path}` : ""}${capability.version ? ` (${capability.version})` : ""}`,
    );
    if (capability.diagnostic) lines.push(`    ${capability.diagnostic}`);
  }
  lines.push(
    `device: ${report.device.status} (${report.device.diagnostic})`,
    `registered tools: ${report.registeredTools.length}; runnable: ${report.runnableTools.length}`,
    `summary: ${report.summary.ok ? "OK" : "DEGRADED"} missing=${report.summary.missing.join(",") || "none"} unavailable=${report.summary.unavailable.join(",") || "none"}`,
  );
  return lines.join("\n");
}
