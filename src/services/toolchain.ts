// ISSUE-168: the MCP server runs on the host. When a toolchain image is
// configured, Android/JVM executables run inside that container instead of the
// host; device tooling (adb, emulator) stays on the host. This module is pure:
// process execution lives in process-runner.ts, the approved boundary.
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Executables supplied by the toolchain image. Anything else (adb, git, ps,
 * unzip, strings, emulator) keeps running on the host: it is either the device
 * boundary or a generic host utility, not an Android SDK dependency.
 */
export const TOOLCHAIN_COMMANDS = Object.freeze([
  "gradle",
  "java",
  "javac",
  "aapt2",
  "jadx",
  "apktool",
  "frida",
  "frida-ps",
  "mitmdump",
  "maestro",
  "compose-preview",
  "android",
]);

const TOOLCHAIN_SET = new Set<string>(TOOLCHAIN_COMMANDS);

export type ToolchainMode = "host" | "docker";

/**
 * Bind mounts name paths on the daemon's host. A remote daemon would mount
 * unrelated (usually empty) directories; treat that as unavailable, not as a
 * missing project.
 */
export function isRemoteDockerEndpoint(endpoint: string): boolean {
  const value = endpoint.trim();
  if (value.startsWith("ssh://")) return true;
  if (!/^(?:tcp|https?):\/\//.test(value)) return false;
  try {
    const url = new URL(value.replace(/^tcp:/, "http:"));
    return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return true;
  }
}

/** Image reference from the host environment; no default means host mode. */
export function toolchainImage(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ANDROID_MCP_TOOLCHAIN_IMAGE?.trim();
  return value ? value : null;
}

export function toolchainMode(env: NodeJS.ProcessEnv = process.env): ToolchainMode {
  return toolchainImage(env) ? "docker" : "host";
}

/** Container name for an absolute or PATH executable, or null when host-only. */
export function toolchainCommand(cmd: string): string | null {
  const name = basename(cmd).replace(/\.(?:exe|cmd|bat)$/i, "");
  return TOOLCHAIN_SET.has(name) ? name : null;
}

export interface ToolchainMount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** Repo root as seen from src/ or dist/ — two levels up in both cases. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function canonical(path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return existsSync(absolute) ? absolute : null;
  }
}

/**
 * Bind mounts use the same absolute path inside and outside the container, so
 * argv paths need no translation on POSIX hosts. Caches and temp output stay
 * outside the project; the repo is mounted read-only for frida scripts.
 */
export function toolchainMounts(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ToolchainMount[] {
  const mounts: ToolchainMount[] = [];
  const seen = new Set<string>();
  const add = (path: string | undefined, readOnly: boolean): void => {
    if (!path) return;
    const source = canonical(path);
    if (!source) return;
    const key = `${source}:${readOnly}`;
    if (seen.has(key)) return;
    seen.add(key);
    mounts.push({ source, target: source, readOnly });
  };
  add(cwd, false);
  add(env.ANDROID_MCP_WORKSPACE, false);
  add(REPO_ROOT, true);
  add(tmpdir(), false);
  add(
    env.ANDROID_MCP_STATE_DIR ??
      (env.XDG_STATE_HOME
        ? join(env.XDG_STATE_HOME, "android-mcp")
        : join(homedir(), ".local", "state", "android-mcp")),
    false,
  );
  add(env.GRADLE_USER_HOME ?? join(homedir(), ".gradle"), false);
  // Docker applies overlapping binds in argv order: mount parents before
  // children or `/tmp` would hide a project that lives under it.
  return mounts.sort((a, b) => a.source.split("/").length - b.source.split("/").length);
}

/** Device endpoints only; host paths and arbitrary env are not forwarded. */
const PASSTHROUGH_ENV = ["ANDROID_SERIAL", "ADB_SERVER_SOCKET"] as const;

function passthroughEnv(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const name of PASSTHROUGH_ENV) {
    const value = env[name];
    if (value) args.push("-e", `${name}=${value}`);
  }
  return args;
}

export interface ContainerOptions {
  image: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type ContainerInvocation =
  { ok: true; command: "docker"; args: string[] } | { ok: false; message: string };

/**
 * Build the `docker run` argv for a toolchain command. Returns null when the
 * command is host-owned, so callers never silently wrap adb/git/ps.
 */
export function containerInvocation(
  cmd: string,
  args: readonly string[],
  options: ContainerOptions,
): ContainerInvocation | null {
  const tool = toolchainCommand(cmd);
  if (!tool) return null;
  if (!options.image.trim()) {
    return {
      ok: false,
      message:
        "ANDROID_MCP_TOOLCHAIN_IMAGE is empty; set it to the toolchain image " +
        "reference or unset it to use host tools. No fallback was attempted.",
    };
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      ok: false,
      message:
        "Docker toolchain execution is not supported on Windows yet: host paths " +
        "cannot be translated into container paths. Unset " +
        "ANDROID_MCP_TOOLCHAIN_IMAGE to use host tools. No fallback was attempted.",
    };
  }
  const env = options.env ?? process.env;
  const cwd = options.cwd ? (canonical(options.cwd) ?? resolve(options.cwd)) : null;
  const dockerArgs = ["run", "--rm", "--init"];
  for (const mount of toolchainMounts(options.cwd, env)) {
    // shortcut: POSIX-only identity mounts; add Windows path translation in #168.
    dockerArgs.push("-v", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
  }
  if (cwd) dockerArgs.push("-w", cwd);
  dockerArgs.push(...passthroughEnv(env), options.image, tool, ...args);
  return { ok: true, command: "docker", args: dockerArgs };
}
