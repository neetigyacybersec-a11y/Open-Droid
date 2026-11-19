import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SERVE_STATE_FILE path helper (lazy: env may be set after import, e.g. tests).
// Env-overridable for tests via ANDROID_MCP_SERVE_STATE.
export function serveStatePath(): string {
  return process.env.ANDROID_MCP_SERVE_STATE ?? `${tmpdir()}/android-mcp-serve.json`;
}

export async function tmpDir(prefix = "android-mcp-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function readBase64(path: string): Promise<string> {
  const buf = await readFile(path);
  return buf.toString("base64");
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function validateGradleTask(t: string): boolean {
  // Issue 68: the previous pattern accepted a leading '-' ("-Ievil.gradle"
  // parses as a Gradle option). Identifiers must start with a letter, digit,
  // '_', ':' or '.', never a dash; dashes stay legal *inside* the value.
  return /^[a-zA-Z0-9_:.][a-zA-Z0-9_:.-]*$/.test(t);
}

export function validatePackageName(p: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(p);
}

// Issue 68: values that would be parsed as CLI options are rejected when the
// call semantics require a name/path, not a flag.
export function notOptionLike(v: string): boolean {
  return typeof v === "string" && v !== "" && !v.startsWith("-");
}

/** Stable message extraction for unknown thrown values (#95). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
