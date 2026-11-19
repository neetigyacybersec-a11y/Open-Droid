// ISSUE-96: the approved host process runner. Every host command is executed
// with an argv array through execFile; no module should build a shell string or
// import node:child_process directly. Failures are returned as data (exit code,
// stdout, stderr) instead of being converted into success or thrown silently.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120_000,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      code?: number | string;
    };
    const stderr = failure.stderr || failure.message || String(error);
    return {
      stdout: failure.stdout ?? "",
      stderr,
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

export function which(cmd: string): Promise<string | null> {
  // `which` does not exist on Windows; `where.exe` is always present there.
  if (process.platform === "win32") {
    return run("where", [cmd]).then((result) =>
      result.code === 0 ? (result.stdout.trim().split(/\r?\n/)[0] ?? null) : null,
    );
  }
  return run("which", [cmd]).then((result) => (result.code === 0 ? result.stdout.trim() : null));
}
