#!/usr/bin/env node
// ISSUE-144: distinguish missing, stale and current dist/ before a launch
// script starts serving older compiled code. Production images have no src/
// tree, so the manifest alone is authoritative there.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MANIFEST_REL, sourceFingerprint } from "./build-manifest.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {{ state: "missing"|"stale"|"current", detail: string }} */
export function buildState(root = REPO) {
  const index = join(root, "dist", "index.js");
  if (!existsSync(index)) {
    return { state: "missing", detail: "dist/index.js is absent. Run `npm run build`." };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, MANIFEST_REL), "utf8"));
  } catch {
    return {
      state: "stale",
      detail: `dist/build-manifest.json is missing or unreadable. Run \`npm run build\`.`,
    };
  }
  if (!existsSync(join(root, "src"))) {
    return { state: "current", detail: "production build (no src/ tree; manifest present)" };
  }
  if (typeof manifest.sourceFingerprint !== "string") {
    return {
      state: "stale",
      detail: "build manifest has no source fingerprint. Run `npm run build`.",
    };
  }
  const current = sourceFingerprint(root);
  if (current !== manifest.sourceFingerprint) {
    return {
      state: "stale",
      detail: "src/ has changed since dist/ was built. Run `npm run build`.",
    };
  }
  return { state: "current", detail: `built ${manifest.builtAt ?? "unknown"}` };
}

/** Launch readiness: the compiled entrypoint must parse and be up to date. */
export function runtimeReady(root = REPO) {
  if (buildState(root).state !== "current") return false;
  const check = spawnSync(process.execPath, ["--check", join(root, "dist", "index.js")], {
    encoding: "utf8",
  });
  return check.status === 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1]) : REPO;
  const result = buildState(root);
  if (!process.argv.includes("--quiet") || result.state !== "current") {
    console.log(`build ${result.state}: ${result.detail}`);
  }
  if (process.argv.includes("--require-current") && result.state !== "current") process.exit(1);
}
