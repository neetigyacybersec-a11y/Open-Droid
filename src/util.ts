import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
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
  return /^[:a-zA-Z0-9_.-]+$/.test(t);
}

export function validatePackageName(p: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(p);
}
