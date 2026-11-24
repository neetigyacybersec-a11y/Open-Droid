// ISSUE-153: every successful install/update gets a verified generation.
// Rollback restores only installer-owned runtime paths from that generation;
// it performs no destructive Git operations and never touches user projects.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { collectDoctor } from "./installer/doctor.mjs";
import { ownedPaths, readManifest, writeManifest } from "./installer/manifest.mjs";

const GENERATIONS = "generations";
const HISTORY = "rollback-history.jsonl";

function generationRoot(root) {
  return join(resolve(root), GENERATIONS);
}
// Manifest paths are relative to the repository root, not the managed
// .toolchain directory where the manifest itself lives.
const repoRoot = (root) => resolve(root, "..");

export function listGenerations(root) {
  const dir = generationRoot(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(join(dir, entry.name, "state.json"), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function recordEvent(root, event) {
  const dir = generationRoot(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, HISTORY),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    { flag: "a" },
  );
}

/** Snapshot the ownership manifest and the managed runtime of one generation. */
export function createGeneration(root, { mode = "managed", reason = "install", version = null, sourceCommit = null } = {}) {
  const manifest = readManifest(root);
  if (!manifest) throw new Error("no install manifest; refusing to create a generation");
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const dir = join(generationRoot(root), id);
  mkdirSync(join(dir, "components"), { recursive: true });
  const state = {
    id,
    createdAt: new Date().toISOString(),
    mode,
    reason,
    version: version ?? manifest.version ?? null,
    sourceCommit,
    verified: false,
    paths: [],
  };
  for (const owned of ownedPaths(manifest, repoRoot(root))) {
    if (!existsSync(owned.absolute)) continue;
    const rel = relative(repoRoot(root), owned.absolute);
    const target = join(dir, "components", owned.id, rel);
    mkdirSync(target, { recursive: true });
    cpSync(owned.absolute, join(target, basename(owned.absolute)), { recursive: true, force: true });
    state.paths.push({ id: owned.id, relative: rel, name: basename(owned.absolute) });
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  recordEvent(root, { type: "generation-created", id, mode, reason });
  return state;
}

export function verifyGeneration(root, id) {
  const state = listGenerations(root).find((generation) => generation.id === id);
  if (!state) throw new Error(`unknown generation: ${id}`);
  const missing = state.paths.filter((entry) => !existsSync(resolve(repoRoot(root), entry.relative)));
  state.verified = missing.length === 0;
  state.verifiedAt = new Date().toISOString();
  writeFileSync(join(generationRoot(root), id, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  recordEvent(root, { type: "generation-verified", id, ok: state.verified, missing });
  return state;
}

/** Restore a verified generation's owned runtime paths; return a doctor report. */
export function rollbackGeneration(root, { id, verify = true } = {}) {
  const state = listGenerations(root).find((generation) => generation.id === id);
  if (!state) throw new Error(`unknown generation: ${id}`);
  const dir = join(generationRoot(root), id);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const restored = [];
  for (const entry of state.paths) {
    const absolute = resolve(repoRoot(root), entry.relative);
    // Defence in depth: never restore outside the managed root.
    const rel = relative(repoRoot(root), absolute);
    if (rel.startsWith("..") || rel.startsWith(`${sep}..`)) {
      throw new Error(`generation path escapes installation root: ${entry.relative}`);
    }
    const source = join(dir, "components", entry.id, entry.relative, entry.name);
    if (!existsSync(source)) continue;
    rmSync(absolute, { recursive: true, force: true });
    mkdirSync(dirname(absolute), { recursive: true });
    cpSync(source, absolute, { recursive: true, force: true });
    restored.push(entry.relative);
  }
  writeManifest(root, manifest);
  const doctor = verify ? collectDoctor({ root: resolve(root, ".."), installRoot: root }) : null;
  recordEvent(root, { type: "rollback", id, restored, doctorOk: doctor?.summary.ok ?? null });
  return { state, restored, doctor };
}
