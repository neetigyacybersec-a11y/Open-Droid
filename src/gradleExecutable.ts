// ISSUE-146: every Gradle-backed handler resolves the runtime through one
// place. The MCP server may run with a PATH prepared by a GUI/daemon, so the
// bundled .toolchain distribution must be found without shell setup.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type RunOptions, type RunResult } from "./services/process-runner.js";
import { toolchainMode } from "./services/toolchain.js";

export type GradleSource =
  | "container"
  | "ANDROID_MCP_GRADLE_HOME"
  | "ANDROID_GRADLE_HOME"
  | "bundled"
  | "GRADLE_HOME"
  | "PATH";

export interface GradleExecutable {
  /** The executable to launch (may be cmd.exe for a Windows .bat). */
  command: string;
  /** Arguments that must precede every Gradle task (the /c wrapper on Windows). */
  argsPrefix: string[];
  /** Absolute path of the selected Gradle launcher. */
  path: string;
  source: GradleSource;
}

export type GradleResolution =
  { ok: true; executable: GradleExecutable } | { ok: false; attempts: string[]; message: string };

export interface GradleResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  root?: string;
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function executableAt(home: string, platform: NodeJS.Platform): string | null {
  const names =
    platform === "win32" ? ["gradle.bat", "gradle.cmd", "gradle.exe", "gradle"] : ["gradle"];
  for (const name of names) {
    const candidate = join(home, "bin", name);
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) continue;
      if (platform !== "win32") accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next launcher name.
    }
  }
  return null;
}

function findOnPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const names =
    platform === "win32" ? ["gradle.bat", "gradle.cmd", "gradle.exe", "gradle"] : ["gradle"];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning.
      }
    }
  }
  return null;
}

/** Resolve the Gradle launcher: explicit homes, bundled toolchain, then PATH. */
export function resolveGradleExecutable(options: GradleResolveOptions = {}): GradleResolution {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const root = options.root ?? defaultRoot();
  const attempts: string[] = [];
  // ISSUE-168: in container mode Gradle comes from the image; never fall back
  // to a host Gradle install. process-runner routes the name into the image.
  if (toolchainMode(env) === "docker") {
    if (platform === "win32") {
      return {
        ok: false,
        attempts,
        message:
          "Gradle runs in the toolchain container, which does not support Windows " +
          "host paths yet. Unset ANDROID_MCP_TOOLCHAIN_IMAGE to use host Gradle.",
      };
    }
    return {
      ok: true,
      executable: { command: "gradle", argsPrefix: [], path: "gradle", source: "container" },
    };
  }
  const homes: Array<[GradleSource, string | undefined]> = [
    ["ANDROID_MCP_GRADLE_HOME", env.ANDROID_MCP_GRADLE_HOME],
    ["ANDROID_GRADLE_HOME", env.ANDROID_GRADLE_HOME],
    ["bundled", join(root, ".toolchain", "gradle")],
    ["GRADLE_HOME", env.GRADLE_HOME],
  ];
  for (const [source, home] of homes) {
    if (!home) continue;
    const executable = executableAt(home, platform);
    if (executable) {
      return { ok: true, executable: invocationFor(executable, source, platform) };
    }
    attempts.push(`${source}=${home} (no executable in bin/)`);
  }
  const onPath = findOnPath(env, platform);
  if (onPath) {
    return { ok: true, executable: invocationFor(onPath, "PATH", platform) };
  }
  attempts.push("PATH (no gradle launcher)");
  return {
    ok: false,
    attempts,
    message:
      "Gradle executable not found. Set ANDROID_MCP_GRADLE_HOME to a Gradle " +
      "distribution, or run `make setup` to install the bundled toolchain.\n" +
      `Resolution attempts: ${attempts.join("; ")}`,
  };
}

/** A single argv value is passed to cmd.exe; quotes prevent shell injection. */
export function batchCommandLine(executable: string, args: readonly string[]): string {
  const quote = (value: string): string => {
    if (/["\r\n\0]/.test(value)) {
      throw new Error("Gradle arguments may not contain quotes or control characters");
    }
    // cmd expands %VAR% even inside quotes; doubling is cmd's escape.
    return `"${value.replace(/%/g, "%%")}"`;
  };
  return `"${executable.replace(/%/g, "%%")}"${args.length > 0 ? ` ${args.map(quote).join(" ")}` : ""}`;
}

function invocationFor(
  executable: string,
  source: GradleSource,
  platform: NodeJS.Platform,
): GradleExecutable {
  if (platform === "win32" && /\.(bat|cmd)$/i.test(executable)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      argsPrefix: ["/d", "/s", "/c"],
      path: executable,
      source,
    };
  }
  return { command: executable, argsPrefix: [], path: executable, source };
}

export interface RunGradleOptions extends RunOptions, GradleResolveOptions {
  /** Override the resolved launcher; used by tests. */
  executable?: GradleExecutable;
}

/** Run Gradle through the shared resolver. A missing install is data, not a throw. */
export async function runGradle(
  args: string[],
  options: RunGradleOptions = {},
): Promise<RunResult> {
  const resolved = options.executable
    ? { ok: true as const, executable: options.executable }
    : resolveGradleExecutable(options);
  if (!resolved.ok) {
    return { stdout: "", stderr: resolved.message, code: 127 };
  }
  const invocation = resolved.executable;
  let commandArgs: string[];
  if (invocation.argsPrefix.length > 0) {
    try {
      commandArgs = [...invocation.argsPrefix, `"${batchCommandLine(invocation.path, args)}"`];
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        code: 2,
      };
    }
  } else {
    commandArgs = [...invocation.argsPrefix, ...args];
  }
  return run(invocation.command, commandArgs, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: options.env,
  });
}

/** Complete argv for a Gradle invocation, including a Windows batch wrapper. */
export function gradleArgv(
  taskAndArgs: readonly string[],
  options: GradleResolveOptions = {},
): string[] {
  const resolved = resolveGradleExecutable(options);
  if (!resolved.ok) return ["gradle", ...taskAndArgs];
  const executable = resolved.executable;
  if (executable.argsPrefix.length === 0) {
    return [executable.command, ...taskAndArgs];
  }
  try {
    return [
      executable.command,
      ...executable.argsPrefix,
      `"${batchCommandLine(executable.path, taskAndArgs)}"`,
    ];
  } catch {
    return ["gradle", ...taskAndArgs];
  }
}

export { defaultRoot as gradleResolutionRoot };
