import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SERVE_STATE_FILE path helper (lazy: env may be set after import, e.g. tests).
// Env-overridable for tests via ANDROID_MCP_SERVE_STATE.
export function serveStatePath(): string {
  return process.env.ANDROID_MCP_SERVE_STATE ?? `${tmpdir()}/android-mcp-serve.json`;
}

export const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120_000,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (e: any) {
    return {
      stdout: e?.stdout ?? "",
      stderr: e?.stderr ?? e?.message ?? String(e),
      code: typeof e?.code === "number" ? e.code : 1,
    };
  }
}

export function which(cmd: string): Promise<string | null> {
  // `which` does not exist on Windows; `where.exe` is always present there.
  if (process.platform === "win32") {
    return run("where", [cmd]).then((r) =>
      r.code === 0 ? (r.stdout.trim().split(/\r?\n/)[0] ?? null) : null,
    );
  }
  return run("which", [cmd]).then((r) => (r.code === 0 ? r.stdout.trim() : null));
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

// Issue 67: adb joins everything after "shell" with spaces and the DEVICE's
// shell re-parses that string, so local execFile argument arrays do NOT
// preserve remote argument boundaries. Quote for the remote shell: wrap in
// single quotes, escaping embedded single quotes POSIX-style ('\'').
export function shquote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// Issue 67: destructive remote paths must be absolute, in a test-relevant
// scope, and free of shell metacharacters and traversal.
export function validateRemotePath(p: string): boolean {
  return (
    typeof p === "string" &&
    p.startsWith("/") &&
    !p.includes("..") &&
    !/["'`\n\r;|&$<>(){}[\]#*?!~]/.test(p) &&
    /^(\/sdcard|\/storage\/emulated|\/data\/local\/tmp|\/cache|\/data\/data)\//.test(p)
  );
}

// Issue 68: values that would be parsed as CLI options are rejected when the
// call semantics require a name/path, not a flag.
export function notOptionLike(v: string): boolean {
  return typeof v === "string" && v !== "" && !v.startsWith("-");
}

// Issue 67: intent actions ("am broadcast -a", "am start -a") and component
// names ("am startservice -n pkg/cls") have constrained grammars.
export function validateIntentAction(a: string): boolean {
  return /^[a-zA-Z0-9_.$]+$/.test(a) && a.split(".").every((s) => s.length > 0);
}

export function validateComponent(c: string): boolean {
  // Full component form: package/class, both segments non-empty.
  return /^[a-zA-Z][a-zA-Z0-9_.$]*\/[a-zA-Z][a-zA-Z0-9_.$]*$/.test(c);
}
