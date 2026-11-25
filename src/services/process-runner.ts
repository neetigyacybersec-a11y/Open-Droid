// ISSUE-96: the approved host process runner. Every host command is executed
// with an argv array through execFile; no module should build a shell string or
// import node:child_process directly. Failures are returned as data (exit code,
// stdout, stderr) instead of being converted into success or thrown silently.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  containerInvocation,
  isRemoteDockerEndpoint,
  toolchainCommand,
  toolchainImage,
} from "./toolchain.js";

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

interface Execution {
  command: string;
  args: string[];
  image: string | null;
}

/**
 * ISSUE-168: route Android/JVM toolchain commands into the managed container.
 * Device tools and host utilities are not in the allowlist and stay local.
 * Returns a RunResult instead when routing is configured but impossible.
 */
function routeExecution(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Execution | { error: RunResult } {
  const image = toolchainImage();
  if (!image) return { command: cmd, args, image: null };
  const invocation = containerInvocation(cmd, args, {
    image,
    cwd: opts.cwd,
    env: process.env,
    platform: process.platform,
  });
  if (!invocation) return { command: cmd, args, image: null };
  if (!invocation.ok) return { error: { stdout: "", stderr: invocation.message, code: 127 } };
  return { command: invocation.command, args: invocation.args, image };
}

let remoteMountError: Promise<string | null> | null = null;

/** One-time context check: remote daemons cannot see the MCP host's paths. */
function checkMountable(): Promise<string | null> {
  remoteMountError ??= run(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { timeout: 15_000 },
  ).then((result) => {
    if (result.code !== 0) return null;
    const endpoint = result.stdout.trim();
    return isRemoteDockerEndpoint(endpoint)
      ? `Docker context endpoint ${endpoint} is remote; bind mounts must resolve on the MCP host. ` +
          "Use a local Docker engine for container mode (no fallback attempted)."
      : null;
  });
  return remoteMountError;
}

async function toolchainBlock(cmd: string): Promise<RunResult | null> {
  if (!toolchainImage() || !toolchainCommand(cmd)) return null;
  const remote = await checkMountable();
  return remote ? { stdout: "", stderr: remote, code: 127 } : null;
}

function failureResult(error: unknown, image: string | null): RunResult {
  const failure = error as {
    stdout?: string;
    stderr?: string;
    message?: string;
    code?: number | string;
  };
  const message = failure.stderr || failure.message || String(error);
  return {
    stdout: failure.stdout ?? "",
    stderr: image ? `toolchain image ${image}: ${message}` : message,
    code: typeof failure.code === "number" ? failure.code : 1,
  };
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const blocked = await toolchainBlock(cmd);
  if (blocked) return blocked;
  const execution = routeExecution(cmd, args, opts);
  if ("error" in execution) return execution.error;
  try {
    const { stdout, stderr } = await execFileAsync(execution.command, execution.args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 120_000,
      env: { ...process.env, ...(opts.env ?? {}) },
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (error: unknown) {
    return failureResult(error, execution.image);
  }
}

export interface ToolchainStatus {
  mode: "host" | "docker";
  image: string | null;
  available: boolean;
  daemon?: string;
  id?: string;
  reason?: string;
}

/**
 * Host MCP and container toolchain are separate health layers: Docker missing,
 * daemon down, image absent and image present must be distinguishable.
 */
export async function toolchainStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolchainStatus> {
  const image = toolchainImage(env);
  if (!image) return { mode: "host", image: null, available: true };
  if (process.platform === "win32") {
    return {
      mode: "docker",
      image,
      available: false,
      reason: "host path translation is not implemented on Windows yet",
    };
  }
  const daemon = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
  });
  if (daemon.code !== 0) {
    return {
      mode: "docker",
      image,
      available: false,
      reason: `Docker daemon unavailable: ${(daemon.stderr || daemon.stdout).split("\n")[0]}`,
    };
  }
  const context = await run(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { timeout: 15_000 },
  );
  if (context.code === 0 && isRemoteDockerEndpoint(context.stdout)) {
    return {
      mode: "docker",
      image,
      available: false,
      daemon: daemon.stdout.trim(),
      reason: `Docker endpoint ${context.stdout.trim()} is remote; bind mounts must resolve on the MCP host`,
    };
  }
  const inspect = await run("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    timeout: 15_000,
  });
  if (inspect.code !== 0) {
    return {
      mode: "docker",
      image,
      available: false,
      daemon: daemon.stdout.trim(),
      reason: `image not present: ${image} (build or pull it; no host fallback)`,
    };
  }
  return {
    mode: "docker",
    image,
    available: true,
    daemon: daemon.stdout.trim(),
    id: inspect.stdout.trim(),
  };
}

export async function which(cmd: string): Promise<string | null> {
  const image = toolchainImage();
  if (image && toolchainCommand(cmd)) {
    if (process.platform === "win32") return null;
    // A remote daemon sees none of this host's mounts; report no capability.
    if (await checkMountable()) return null;
    // Query the image, not the host: a host install must not mask a missing
    // tool in the configured container.
    const result = await run(
      "docker",
      ["run", "--rm", "--network", "none", image, "sh", "-c", 'command -v "$1"', "sh", cmd],
      { timeout: 60_000 },
    );
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  // `which` does not exist on Windows; `where.exe` is always present there.
  if (process.platform === "win32") {
    return run("where", [cmd]).then((result) =>
      result.code === 0 ? (result.stdout.trim().split(/\r?\n/)[0] ?? null) : null,
    );
  }
  return run("which", [cmd]).then((result) => (result.code === 0 ? result.stdout.trim() : null));
}
