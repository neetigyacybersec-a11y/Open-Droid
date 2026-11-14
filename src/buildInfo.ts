// ISSUE-24: MCP clients cache tools/list for the lifetime of the client
// session. After an upgrade or a rebuild the running server keeps the old tool
// list, so android_env_check reports the build it loaded and whether the on-disk
// build has changed since startup.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface BuildIdentity {
  name: string;
  version: string;
  /** sha256 over the manifest version and each module's name, size and mtime. */
  fingerprint: string;
  /** ISO timestamp of the newest module file (0 epoch when the build is empty). */
  builtAt: string;
}

export interface RestartStatus {
  required: boolean;
  reasons: string[];
  instruction: string;
}

function readManifest(moduleDir: string): { name?: unknown; version?: unknown } {
  try {
    return JSON.parse(readFileSync(resolve(moduleDir, "..", "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Read the identity of the build in `moduleDir` (the directory holding this module). */
export function readBuildIdentity(moduleDir: string = MODULE_DIR): BuildIdentity {
  const manifest = readManifest(moduleDir);
  const name = typeof manifest.name === "string" ? manifest.name : "android-mcp";
  const version = typeof manifest.version === "string" ? manifest.version : "unknown";

  let modules: Array<{ name: string; size: number; mtimeMs: number }> = [];
  try {
    modules = readdirSync(moduleDir)
      .filter((file) => file.endsWith(".js") || file.endsWith(".ts"))
      .sort()
      .map((file) => {
        const stats = statSync(join(moduleDir, file));
        return { name: file, size: stats.size, mtimeMs: stats.mtimeMs };
      });
  } catch {
    // A missing directory is reported as version-only; never crash env_check.
  }

  const hash = createHash("sha256");
  hash.update(`${name}@${version}\n`);
  let newest = 0;
  for (const module of modules) {
    hash.update(`${module.name}:${module.size}:${module.mtimeMs}\n`);
    newest = Math.max(newest, module.mtimeMs);
  }

  return {
    name,
    version,
    fingerprint: hash.digest("hex"),
    builtAt: new Date(newest).toISOString(),
  };
}

/** The build loaded into this process; frozen at module import. */
export const STARTUP_BUILD: BuildIdentity = readBuildIdentity();

/** When this server process began serving (ISO). */
export const SERVER_STARTED_AT = new Date().toISOString();

/**
 * Compare the loaded build with the current on-disk build. A version bump or a
 * rebuild (new mtimes/sizes) means a client that keeps its cached tools/list is
 * looking at stale tools and must restart the client/server.
 */
export function checkRestartRequired(
  startup: BuildIdentity = STARTUP_BUILD,
  current: BuildIdentity = readBuildIdentity(),
): RestartStatus {
  const reasons: string[] = [];
  if (startup.version !== current.version) {
    reasons.push(`version ${startup.version} -> ${current.version}`);
  }
  if (startup.fingerprint !== current.fingerprint) {
    reasons.push("the on-disk build changed after this server started");
  }
  if (reasons.length === 0) return { required: false, reasons, instruction: "" };
  return {
    required: true,
    reasons,
    instruction:
      "MCP clients cache tools/list; restart the MCP client (or reload this server) " +
      "to pick up new or changed tools.",
  };
}
