// ISSUE-16: persistent capture archive and managed golden baselines.
//
// Capture paths are server-owned (env-configured), not caller-supplied paths,
// so they deliberately bypass the workspace path policy that guards explicit
// outputPath arguments. Env is resolved lazily so tests can override it.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_KEEP = 200;
const MAX_KEEP = 10_000;

export type CaptureKind = "screenshot" | "screenrecord";

export function capturesDir(): string {
  return (
    process.env.ANDROID_MCP_CAPTURES_DIR?.trim() || join(homedir(), ".android-mcp", "captures")
  );
}

export function baselinesDir(): string {
  return join(capturesDir(), "baselines");
}

export function capturesKeep(): number {
  const raw = Number(process.env.ANDROID_MCP_CAPTURES_KEEP);
  return Number.isInteger(raw) && raw > 0 && raw <= MAX_KEEP ? raw : DEFAULT_KEEP;
}

export function sanitizeSegment(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "");
  return cleaned || fallback;
}

export function nextCapturePath(options: {
  kind: CaptureKind;
  deviceId?: string;
  packageName?: string;
  epochMs?: number;
}): string {
  const extension = options.kind === "screenshot" ? ".png" : ".mp4";
  const device = sanitizeSegment(options.deviceId, "device");
  const pkg = sanitizeSegment(options.packageName, "unknown");
  const epoch = options.epochMs ?? Date.now();
  return join(capturesDir(), `${options.kind}-${device}-${pkg}-${epoch}${extension}`);
}

export async function ensureCapturesDir(): Promise<void> {
  await mkdir(capturesDir(), { recursive: true });
  await mkdir(baselinesDir(), { recursive: true });
}

/** Remove the oldest archived captures; baselines are explicit keepers. */
export async function pruneCaptures(keep = capturesKeep()): Promise<number> {
  const entries = await readdir(capturesDir(), { withFileTypes: true }).catch(() => []);
  const captures = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(screenshot|screenrecord)-.+\.(png|mp4)$/.test(name))
    // The trailing epoch is the timestamp; device/package segments before it
    // are not, so name order is not time order.
    .sort((a, b) => {
      const epochA = Number(a.match(/-(\d+)\.(?:png|mp4)$/)?.[1] ?? 0);
      const epochB = Number(b.match(/-(\d+)\.(?:png|mp4)$/)?.[1] ?? 0);
      return epochA - epochB || a.localeCompare(b);
    });
  const expired = captures.slice(0, Math.max(0, captures.length - keep));
  await Promise.all(expired.map((name) => rm(join(capturesDir(), name), { force: true })));
  return expired.length;
}

export function isValidBaselineName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

function baselineFile(name: string): string {
  return join(baselinesDir(), `${name}.png`);
}

function metadataFile(name: string): string {
  return join(baselinesDir(), `${name}.json`);
}

interface BaselineMetadata {
  name: string;
  deviceId: string;
  packageName: string;
  createdAt: string;
  sha256: string;
  bytes: number;
  sourceCapture: string | null;
}

export interface BaselineRecord extends BaselineMetadata {
  path: string;
  metadataPath: string;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function buildMetadata(
  options: { name: string; deviceId?: string; packageName?: string; sourceCapture?: string },
  content: Buffer,
): BaselineMetadata {
  return {
    name: options.name,
    deviceId: sanitizeSegment(options.deviceId, "unknown"),
    packageName: sanitizeSegment(options.packageName, "unknown"),
    createdAt: new Date().toISOString(),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
    sourceCapture: options.sourceCapture ?? null,
  };
}

function withPaths(metadata: BaselineMetadata): BaselineRecord {
  return {
    ...metadata,
    path: baselineFile(metadata.name),
    metadataPath: metadataFile(metadata.name),
  };
}

export async function saveBaseline(options: {
  name: string;
  sourcePath: string;
  deviceId?: string;
  packageName?: string;
  sourceCapture?: string;
  overwrite?: boolean;
}): Promise<BaselineRecord> {
  if (!isValidBaselineName(options.name)) throw new Error(`invalid baseline name: ${options.name}`);
  if (!options.overwrite && (await pathExists(baselineFile(options.name))))
    throw new Error(`baseline "${options.name}" exists; pass overwrite: true to replace`);

  const content = await readFile(options.sourcePath);
  const metadata = buildMetadata(options, content);
  await mkdir(baselinesDir(), { recursive: true });
  await writeFile(baselineFile(options.name), content);
  await writeFile(metadataFile(options.name), JSON.stringify(metadata, null, 2));
  return withPaths(metadata);
}

async function readBaseline(name: string): Promise<BaselineRecord> {
  const raw = await readFile(metadataFile(name), "utf8");
  return withPaths(JSON.parse(raw) as BaselineMetadata);
}

export async function resolveBaseline(name: string): Promise<BaselineRecord | null> {
  if (!isValidBaselineName(name)) return null;
  try {
    return await readBaseline(name);
  } catch {
    return null;
  }
}

export async function listBaselines(): Promise<BaselineRecord[]> {
  const files = await readdir(baselinesDir()).catch(() => []);
  const names = files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  const records = await Promise.all(names.map((name) => resolveBaseline(name)));
  return records
    .filter((record): record is BaselineRecord => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
