// ISSUE-148/#149: the install manifest is the ownership record used by doctor,
// update, export, uninstall and rollback. Writes are atomic.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MANIFEST_FILE = "install-manifest.json";
export const manifestPath = (root) => join(resolve(root), MANIFEST_FILE);

export function readManifest(root) {
  try {
    return JSON.parse(readFileSync(manifestPath(root), "utf8"));
  } catch {
    return null;
  }
}

export function writeManifest(root, manifest) {
  const target = manifestPath(root);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, target);
  return manifest;
}

export function newManifest(plan, extra = {}) {
  return {
    schema: plan.schema,
    profile: plan.profile,
    installedAt: new Date().toISOString(),
    sourceCommit: extra.sourceCommit ?? null,
    version: extra.version ?? null,
    components: Object.fromEntries(
      plan.components
        .filter((component) => component.status === "available")
        .map((component) => [
          component.id,
          {
            version: component.version ?? null,
            required: Boolean(component.required),
            source: component.kind === "download" ? component.url : component.kind,
            paths: component.paths ?? (component.path ? [component.path] : []),
          },
        ]),
    ),
    ...extra,
  };
}

/** Resolve an owned relative path, refusing traversal and absolute paths. */
export function ownedPath(root, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)) {
    throw new Error(`not a managed relative path: ${path}`);
  }
  const base = resolve(root);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`path escapes installation root: ${path}`);
  }
  return target;
}

/** All paths the manifest says Open-Droid owns, validated before any removal. */
export function ownedPaths(manifest, root) {
  const result = [];
  if (!manifest || !manifest.components) return result;
  for (const [id, component] of Object.entries(manifest.components)) {
    for (const path of component.paths ?? []) {
      try {
        result.push({ id, path, absolute: ownedPath(root, path) });
      } catch {
        // A malformed ownership entry is never removed; skip it conservatively.
      }
    }
  }
  return result;
}

export function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
