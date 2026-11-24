// ISSUE-51: project checkpoints and guarded restore. Git-native local store
// under ~/.android-mcp/checkpoints (configurable via ANDROID_MCP_CHECKPOINTS_DIR).
// Snapshots capture tracked and untracked user changes (never silently
// discarding them), exclude build outputs/caches/toolchain/secrets by default,
// preserve file modes, and support dry-run restores with bounded retention.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { run } from "./services/process-runner.js";

export type CheckpointAction = "create" | "list" | "diff" | "restore";

export interface CheckpointFile {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export interface Checkpoint {
  name: string;
  createdAt: string;
  root: string;
  baseCommit: string | null;
  excludeDirs: string[];
  files: CheckpointFile[];
  /** Files skipped by size/count caps; they cannot be restored from this snapshot. */
  omittedFiles: string[];
}

export interface DiffChange {
  path: string;
  change: "changed" | "removed" | "restore";
  from?: string;
}

export interface DiffResult {
  name: string;
  error?: string;
  changes: DiffChange[];
}

export interface RestoreResult {
  name: string;
  error?: string | boolean;
  confirmRequired?: boolean;
  restored: number;
  changes: DiffChange[];
  failed?: string[];
}

const DEFAULT_EXCLUDES = new Set([
  "build",
  "node_modules",
  ".git",
  ".gradle",
  "generated",
  "out",
  "dist",
  "obj",
  "bin",
  "target",
  ".idea",
  ".vscode",
  ".opencode",
  ".toolchain",
  "coverage",
  ".svn",
  ".hg",
]);
const SENSITIVE_FILE_RE =
  /^(\.env.*|local\.properties|.*\.(key|pem|p12|pfx|jks|keystore)|signing\..*|credentials\..*)$/i;
const MAX_SNAPSHOT_FILES = 2000;
const MAX_EXCLUDE = 32;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
function isValidCheckpointName(name: string): boolean {
  return CHECKPOINT_NAME_RE.test(name);
}

function walkFiles(
  dir: string,
  rel: string,
  depth: number,
  excludes: Set<string>,
  out: string[],
): void {
  if (depth > 16) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (excludes.has(entry.name)) continue;
    if (entry.isDirectory()) walkFiles(join(dir, entry.name), child, depth + 1, excludes, out);
    else if (entry.isFile()) out.push(child);
  }
}

function snapshotFiles(
  root: string,
  excludeDirs: readonly string[] = [],
): { included: string[]; omitted: string[] } {
  const files: string[] = [];
  walkFiles(root, "", 0, new Set([...DEFAULT_EXCLUDES, ...excludeDirs]), files);
  const included: string[] = [];
  const omitted: string[] = [];
  for (const f of files.sort()) {
    const base = f.split("/").pop() ?? f;
    if (SENSITIVE_FILE_RE.test(base)) continue;
    try {
      if (statSync(join(root, f)).size > MAX_FILE_BYTES) {
        omitted.push(f);
        continue;
      }
    } catch {
      omitted.push(f);
      continue;
    }
    included.push(f);
  }
  if (included.length > MAX_SNAPSHOT_FILES) {
    omitted.push(...included.splice(MAX_SNAPSHOT_FILES));
  }
  return { included, omitted };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return 0o644;
  }
}

async function gitBaseCommit(root: string): Promise<string | null> {
  const res = await run("git", ["-C", root, "log", "-1", "--format=%H"]);
  return res.code === 0 ? res.stdout.trim() || null : null;
}

function readCheckpointAt(cpDir: string): Checkpoint | null {
  try {
    const raw = readFileSync(join(cpDir, "checkpoint.json"), "utf8");
    const parsed = JSON.parse(raw) as Checkpoint;
    if (parsed && Array.isArray(parsed.files)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function cpDirFor(name: string): string {
  if (!isValidCheckpointName(name)) throw new Error(`invalid checkpoint name: ${name}`);
  return join(checkpointsDir(), name);
}

function checkpointName(inputName?: string): string {
  const name = inputName?.trim() || `ckpt-${Date.now()}`;
  if (!isValidCheckpointName(name)) throw new Error(`invalid checkpoint name: ${name}`);
  return name;
}

/** Create a named checkpoint: manifest + file copies in the local store. */
export async function createCheckpoint(input: {
  projectPath?: string;
  name?: string;
  excludeDirs?: string[];
  retention?: number;
}): Promise<Checkpoint> {
  const root = input.projectPath?.trim() || ".";
  const name = checkpointName(input.name);
  const excludeDirs = [...(input.excludeDirs ?? [])].slice(0, MAX_EXCLUDE);
  const { included, omitted } = snapshotFiles(root, excludeDirs);
  const manifest: Checkpoint = {
    name,
    createdAt: new Date().toISOString(),
    root,
    baseCommit: await gitBaseCommit(root),
    excludeDirs: excludeDirs.map((d) => d.split("\\").join("/")),
    files: included.map((path) => ({
      path,
      sha256: hashFile(join(root, path)),
      bytes: statSync(join(root, path)).size,
      mode: fileMode(join(root, path)),
    })),
    omittedFiles: omitted,
  };
  const cpDir = cpDirFor(name);
  mkdirSync(cpDir, { recursive: true });
  // Copy every file before writing the manifest: a failed copy must not leave
  // a checkpoint that claims to be complete.
  for (const file of manifest.files) {
    const target = join(cpDir, "files", file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file.path), target);
    bestEffortChmod(target, file.mode);
  }
  writeFileSync(join(cpDir, "checkpoint.json"), JSON.stringify(manifest, null, 2));
  if (input.retention) pruneCheckpoints(input.retention);
  return manifest;
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows does not support every chmod mode; preserve the default instead.
  }
}

function pruneCheckpoints(retention: number): void {
  const keep = Math.max(1, retention);
  const all = listCheckpoints().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const entry of all.slice(keep)) {
    rmSync(cpDirFor(entry.name), { recursive: true, force: true });
  }
}

export interface ListEntry {
  name: string;
  createdAt: string;
  root: string;
  baseCommit: string | null;
  fileCount: number;
  files: string[];
  bytes: number;
}

export function checkpointsDir(): string {
  return (
    process.env.ANDROID_MCP_CHECKPOINTS_DIR?.trim() ||
    join(homedir(), ".android-mcp", "checkpoints")
  );
}

/** List all checkpoints in the local store, sorted by name. */
export function listCheckpoints(): ListEntry[] {
  const out: ListEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(checkpointsDir());
  } catch {
    return out;
  }
  for (const name of names) {
    if (!isValidCheckpointName(name)) continue;
    const cp = readCheckpointAt(cpDirFor(name));
    if (!cp) continue;
    out.push({
      // The on-disk entry is authoritative: a manifest cannot steer prune or
      // restore into a path outside the checkpoint store.
      name,
      createdAt: cp.createdAt,
      root: cp.root,
      baseCommit: cp.baseCommit,
      fileCount: cp.files.length,
      files: cp.files.map((f) => f.path),
      bytes: cp.files.reduce((sum, f) => sum + f.bytes, 0),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one checkpoint by name. */
export function readCheckpoint(name: string): Checkpoint | null {
  if (!isValidCheckpointName(name)) return null;
  return readCheckpointAt(cpDirFor(name));
}

/** Diff the current working tree against a checkpoint. */
export function diffCheckpoint(input: {
  name: string;
  projectPath?: string;
  excludeDirs?: string[];
}): DiffResult {
  const cp = readCheckpoint(input.name);
  if (!cp) return { name: input.name, changes: [], error: `checkpoint not found: ${input.name}` };
  const root = input.projectPath?.trim() || cp.root;
  const excludeDirs = input.excludeDirs ?? cp.excludeDirs;
  const current = new Map<string, string>();
  for (const path of snapshotFiles(root, excludeDirs).included)
    current.set(path, hashFile(join(root, path)));
  const changes: DiffChange[] = [];
  for (const file of cp.files) {
    const cur = current.get(file.path);
    if (cur === undefined) {
      changes.push({ path: file.path, change: "removed" });
    } else if (cur !== file.sha256) {
      changes.push({ path: file.path, change: "changed" });
    }
  }
  return { name: cp.name, changes: changes.sort((a, b) => a.path.localeCompare(b.path)) };
}

function readFromCp(cpDir: string, file: CheckpointFile): string {
  try {
    return readFileSync(join(cpDir, "files", file.path), "utf8");
  } catch {
    return "";
  }
}

/**
 * Restore a checkpoint: dry-run by default and always shows exact changes;
 * real restore requires `confirm: true`. Only files that are in the manifest
 * are touched — new unrelated files and excluded secrets are never modified.
 */
export function restoreCheckpoint(input: {
  name: string;
  projectPath?: string;
  excludeDirs?: string[];
  dryRun?: boolean;
  confirm?: boolean;
}): RestoreResult {
  const cp = readCheckpoint(input.name);
  if (!cp)
    return {
      name: input.name,
      restored: 0,
      changes: [],
      error: `checkpoint not found: ${input.name}`,
    };
  const root = input.projectPath?.trim() || cp.root;
  const excludeDirs = input.excludeDirs ?? cp.excludeDirs;
  const current = new Map<string, string>();
  for (const path of snapshotFiles(root, excludeDirs).included)
    current.set(path, hashFile(join(root, path)));
  const changes: DiffChange[] = [];
  for (const file of cp.files) {
    if (current.get(file.path) !== file.sha256) {
      changes.push({
        path: file.path,
        change: "restore",
        from: readFromCp(cpDirFor(cp.name), file),
      });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  if (input.dryRun) return { name: cp.name, restored: 0, changes };
  if (!input.confirm)
    return { name: cp.name, error: true, confirmRequired: true, restored: 0, changes };
  const applied = applyRestores(cp, root, changes);
  return {
    name: cp.name,
    restored: applied.restored,
    changes,
    ...(applied.failed.length > 0
      ? { failed: applied.failed, error: `missing snapshot copy for: ${applied.failed.join(", ")}` }
      : {}),
  };
}

function applyRestores(
  cp: Checkpoint,
  root: string,
  changes: DiffChange[],
): { restored: number; failed: string[] } {
  let restored = 0;
  const failed: string[] = [];
  for (const change of changes) {
    const file = cp.files.find((f) => f.path === change.path);
    if (
      !file ||
      !restoreOne(join(cpDirFor(cp.name), "files", change.path), join(root, change.path), file)
    ) {
      failed.push(change.path);
      continue;
    }
    restored++;
  }
  return { restored, failed };
}

function restoreOne(src: string, dst: string, file: CheckpointFile): boolean {
  mkdirSync(dirname(dst), { recursive: true });
  try {
    copyFileSync(src, dst);
    if (file.mode) bestEffortChmod(dst, file.mode);
    return true;
  } catch {
    return false;
  }
}
