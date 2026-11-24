#!/usr/bin/env node
// ISSUE-144: record which TypeScript sources produced this dist/ build, so a
// launch script can refuse to serve older compiled code after a source update.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_REL = "dist/build-manifest.json";

function sourceFiles(root) {
  const src = join(root, "src");
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
    }
  };
  walk(src);
  return found.sort();
}

/** Stable digest over every TypeScript file under src/. */
export function sourceFingerprint(root = REPO) {
  const hash = createHash("sha256");
  for (const file of sourceFiles(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function writeBuildManifest(root = REPO) {
  const manifest = {
    schema: 1,
    version: readVersion(root),
    sourceFingerprint: sourceFingerprint(root),
    builtAt: new Date().toISOString(),
  };
  const target = join(root, MANIFEST_REL);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex > 0 ? resolve(process.argv[rootIndex + 1]) : REPO;
  const manifest = writeBuildManifest(root);
  console.log(
    `build manifest: ${MANIFEST_REL} (source ${manifest.sourceFingerprint.slice(0, 12)})`,
  );
}
