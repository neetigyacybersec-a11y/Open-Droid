#!/usr/bin/env node
// ISSUE-155: a portable, versioned description of a selected installation.
// No absolute paths, credentials or machine-specific state are exported.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInstall } from "./install.mjs";
import { readManifest } from "./installer/manifest.mjs";
import { readPins, resolvePlan } from "./installer/profiles.mjs";

export const PROFILE_SCHEMA = 1;
const SECRET = /(token|password|secret|credential|api[_-]?key|private[_-]?key)/i;

export function exportProfile({
  root = process.cwd(),
  installRoot,
  manifest = readManifest(installRoot ?? `${root}/.toolchain`),
  platform = process.platform,
} = {}) {
  if (!manifest) throw new Error("no install manifest; cannot export a profile");
  const pins = readPins(root);
  const capabilities = Object.entries(manifest.components ?? {})
    .filter(([, entry]) => entry && !entry.required)
    .map(([id]) => id);
  const profile = {
    schema: PROFILE_SCHEMA,
    kind: "open-droid-install-profile",
    name: "exported-profile",
    profile: manifest.profile ?? "custom",
    platform: { os: platform, arch: process.arch },
    capabilities,
    pins: Object.fromEntries(
      Object.entries(pins).filter(
        ([key, value]) => /^(GRADLE|JADX|APKTOOL|COMPOSE_PREVIEW|MAESTRO|FRIDA|MITMPROXY|NODE|JAVA)_/.test(key) &&
          value &&
          !value.startsWith("/") &&
          !SECRET.test(key),
      ),
    ),
    exportedAt: new Date().toISOString(),
  };
  profile.digest = createHash("sha256")
    .update(JSON.stringify({ ...profile, digest: undefined }))
    .digest("hex");
  return profile;
}

export function validateProfile(value, { platform = process.platform, arch = process.arch } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("profile must be a JSON object");
  if (value.schema !== PROFILE_SCHEMA) throw new Error(`unsupported profile version: ${value.schema}`);
  if (value.kind !== "open-droid-install-profile") throw new Error("not an Open-Droid install profile");
  if (!["core", "full", "custom"].includes(value.profile)) throw new Error(`unknown profile: ${value.profile}`);
  if (!Array.isArray(value.capabilities)) throw new Error("capabilities must be an array");
  if (value.platform && value.platform.os !== platform) {
    throw new Error(`platform mismatch: profile is ${value.platform.os}, host is ${platform}`);
  }
  if (value.platform && value.platform.arch && value.platform.arch !== arch) {
    throw new Error(`architecture mismatch: profile is ${value.platform.arch}, host is ${arch}`);
  }
  for (const key of Object.keys(value)) {
    if (SECRET.test(key)) throw new Error(`secret-like field in profile: ${key}`);
  }
  for (const [key, pin] of Object.entries(value.pins ?? {})) {
    if (typeof pin === "string" && (pin.includes("/") || pin.includes("\\"))) {
      throw new Error(`machine-specific path in pin ${key}`);
    }
  }
  const allowed = new Set(["node", "java", "android-sdk", "mcp", "gradle", "jadx", "apktool", "compose_preview", "maestro", "frida", "frida_server", "android_cli", "rea"]);
  const unknown = value.capabilities.filter((capability) => !allowed.has(capability));
  if (unknown.length) throw new Error(`unknown capabilities: ${unknown.join(", ")}`);
  return value;
}

export function profileDiff(current, imported) {
  const keys = new Set([...Object.keys(current.pins ?? {}), ...Object.keys(imported.pins ?? {})]);
  const changes = [];
  for (const key of [...keys].sort()) {
    if (current.pins?.[key] !== imported.pins?.[key]) {
      changes.push({ key, from: current.pins?.[key] ?? null, to: imported.pins?.[key] ?? null });
    }
  }
  for (const capability of imported.capabilities ?? []) {
    if (!(current.capabilities ?? []).includes(capability)) {
      changes.push({ key: `capability:${capability}`, from: null, to: "enabled" });
    }
  }
  return changes;
}

/** Import reuses the normal installer engine; no separate install path. */
export async function importProfile({
  file,
  root = process.cwd(),
  installRoot,
  confirm = false,
  platform = process.platform,
  install = runInstall,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`invalid profile JSON: ${error.message}`);
  }
  const imported = validateProfile(parsed, { platform });
  const current = existsSync(`${installRoot ?? `${root}/.toolchain`}/install-manifest.json`)
    ? exportProfile({ root, installRoot, platform })
    : { pins: {}, capabilities: [] };
  const diff = profileDiff(current, imported);
  if (!confirm) return { validated: true, diff, applied: false, reason: "confirmation required" };
  const result = await install({
    root: installRoot ?? `${root}/.toolchain`,
    profile: imported.profile === "custom" ? "custom" : "full",
    capabilities: imported.capabilities,
    pins: imported.pins,
    platform,
  });
  return { validated: true, diff, applied: true, result };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  if (argv[0] === "export") {
    const profile = exportProfile({ root: value("--root") });
    if (value("--out")) writeFileSync(value("--out"), `${JSON.stringify(profile, null, 2)}\n`);
    else console.log(JSON.stringify(profile, null, 2));
  } else {
    const result = await importProfile({ file: value("--file"), confirm: argv.includes("--yes") });
    console.log(JSON.stringify(result, null, 2));
  }
}
