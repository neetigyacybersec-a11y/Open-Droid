// ISSUE-102: canonical, request-scoped workspace policy for MCP filesystem
// arguments. Scope checks resolve symlinks and non-existent outputs through the
// nearest existing parent; they are not string-prefix checks.
//
// This guards MCP-controlled filesystem operations. It is not an OS sandbox and
// does not constrain an external coding agent editing files on its own.

import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir as osHomedir, tmpdir as osTmpdir } from "node:os";
import path from "node:path";

export type PathOperation = "read" | "write" | "delete";

export interface ToolPathSpec {
  field: string;
  operation: PathOperation;
}

export interface WorkspaceOptions {
  root?: string;
  extraRoots?: string[];
  tempRoot?: string | null;
  homedir?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

export interface WorkspacePolicy {
  readonly root: string | null;
  readonly roots: readonly string[];
  readonly extraRoots: readonly string[];
  readonly tempRoot: string | null;
  readonly reason: string | null;
  readonly platform: string;
  readonly caseInsensitive: boolean;
  readonly pathApi: path.PlatformPath;
}

export interface PathDecision {
  ok: boolean;
  reason?: string;
  path?: string;
  root?: string;
  operation?: PathOperation;
}

export interface PathGrant {
  readonly id: string;
  readonly requestId: string;
  readonly path: string;
  readonly operation: PathOperation;
  readonly projectRoot: string | null;
  readonly expiresAt: string;
}

function frozenSpecs(...entries: Array<[string, PathOperation]>): readonly ToolPathSpec[] {
  return Object.freeze(entries.map(([field, operation]) => Object.freeze({ field, operation })));
}

/**
 * Explicit classification of every registered tool. A tool missing from this
 * registry is blocked by the execution boundary, so adding a tool requires a
 * deliberate path-policy decision.
 */
export const TOOL_PATH_SPECS: Readonly<Record<string, readonly ToolPathSpec[]>> = Object.freeze({
  android_env_check: frozenSpecs(),
  gradle_task: frozenSpecs(["projectPath", "read"]),
  adb_devices: frozenSpecs(),
  adb_screenshot: frozenSpecs(["outputPath", "write"]),
  adb_install: frozenSpecs(["apkPath", "read"]),
  adb_launch: frozenSpecs(),
  emulator_list_avds: frozenSpecs(),
  emulator_boot: frozenSpecs(),
  maestro_run: frozenSpecs(["flowPath", "read"]),
  compose_preview_render: frozenSpecs(["projectPath", "read"]),
  android_skills_list: frozenSpecs(),
  android_skills_search: frozenSpecs(),
  sdkmanager_install: frozenSpecs(),
  adb_shell: frozenSpecs(),
  adb_logcat: frozenSpecs(),
  runtime_dump: frozenSpecs(),
  frida_ps: frozenSpecs(),
  frida_hook: frozenSpecs(["scriptPath", "read"]),
  frida_trace_methods: frozenSpecs(),
  net_capture: frozenSpecs(),
  gradle_test: frozenSpecs(["projectPath", "read"]),
  gradle_lint: frozenSpecs(["projectPath", "read"]),
  gradle_dependencies: frozenSpecs(["projectPath", "read"]),
  build_variant: frozenSpecs(["projectPath", "read"]),
  baseline_profile_generate: frozenSpecs(["projectPath", "read"]),
  adb_push: frozenSpecs(["localPath", "read"]),
  adb_pull: frozenSpecs(["localPath", "write"]),
  adb_rm: frozenSpecs(),
  adb_uninstall: frozenSpecs(),
  adb_clear_data: frozenSpecs(),
  adb_force_stop: frozenSpecs(),
  adb_reboot: frozenSpecs(),
  adb_screenrecord: frozenSpecs(["outputPath", "write"]),
  adb_input: frozenSpecs(),
  adb_deep_link: frozenSpecs(),
  adb_broadcast: frozenSpecs(),
  adb_service_start: frozenSpecs(),
  adb_wifi: frozenSpecs(),
  adb_battery: frozenSpecs(),
  logcat_filtered: frozenSpecs(),
  anr_check: frozenSpecs(),
  crash_summary: frozenSpecs(),
  ui_dump: frozenSpecs(["outputPath", "write"]),
  compose_recomposition: frozenSpecs(),
  layout_bounds: frozenSpecs(),
  avd_create: frozenSpecs(),
  avd_delete: frozenSpecs(),
  avd_wipe: frozenSpecs(),
  emulator_snapshot: frozenSpecs(),
  apk_info: frozenSpecs(["apkPath", "read"]),
  apk_decompile: frozenSpecs(["apkPath", "read"], ["outputDir", "write"]),
  manifest_inspect: frozenSpecs(["apkPath", "read"]),
  privacy_scan: frozenSpecs(
    ["projectPath", "read"],
    ["declarationsPath", "read"],
    ["reportPath", "write"],
  ),
  secret_scan: frozenSpecs(["projectPath", "read"], ["reportPath", "write"]),
  security_audit: frozenSpecs(["projectPath", "read"], ["reportPath", "write"]),
  policy_preflight: frozenSpecs(["projectPath", "read"], ["reportPath", "write"]),
  native_libs: frozenSpecs(["apkPath", "read"]),
  dex_strings: frozenSpecs(["apkPath", "read"]),
  instrumented_test: frozenSpecs(["projectPath", "read"]),
  test_coverage: frozenSpecs(["projectPath", "read"]),
  macrobenchmark: frozenSpecs(["projectPath", "read"]),
  perfetto_trace: frozenSpecs(["outputPath", "write"]),
  memory_profile: frozenSpecs(),
  startup_time: frozenSpecs(),
  adb_parallel: frozenSpecs(),
  apk_serve: frozenSpecs(["dir", "read"]),
});

function expandHome(value: string, home: string | null, api: path.PlatformPath): string {
  if (value === "~" && home) return home;
  if (home && (value.startsWith("~/") || value.startsWith("~\\"))) {
    return api.join(home, value.slice(2));
  }
  return value;
}

/**
 * Resolve a path to its canonical form. When the target does not exist, the
 * nearest existing ancestor is canonicalized and the missing suffix is
 * appended. A path whose nearest existing component cannot be resolved (for
 * example a broken symlink or permission error) returns null rather than being
 * treated as safe.
 */
export function canonicalizePath(
  input: string,
  opts: { pathApi?: path.PlatformPath; allowMissing?: boolean } = {},
): string | null {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) return null;
  const api = opts.pathApi ?? path;
  const absolute = api.resolve(input);

  try {
    return realpathSync(absolute);
  } catch {
    // Fall through to nearest-existing-parent resolution.
  }

  let current = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = realpathSync(current);
      return suffix.length > 0 ? api.join(real, ...suffix.reverse()) : real;
    } catch (error: any) {
      if (error?.code !== "ENOENT") return null;
      try {
        // A broken symlink exists here; resolving it would follow caller
        // control outside the workspace. Fail closed instead.
        lstatSync(current);
        return null;
      } catch {
        // Truly missing; continue to its parent.
      }
      const parent = api.dirname(current);
      if (parent === current) return null;
      suffix.push(api.basename(current));
      current = parent;
    }
  }
}

const FILESYSTEM_ROOT = Symbol("filesystem-root");

function canonicalRoot(
  input: string,
  api: path.PlatformPath,
  home: string | null,
): string | typeof FILESYSTEM_ROOT | null {
  const expanded = expandHome(input.trim(), home, api);
  if (!expanded) return null;
  const canonical = canonicalizePath(expanded, { pathApi: api });
  if (!canonical) return null;
  if (api.parse(canonical).root === canonical) return FILESYSTEM_ROOT;
  return canonical;
}

/**
 * Build an immutable workspace context. There is no mutable global workspace:
 * every request can construct its own policy and concurrent projects cannot
 * leak roots into each other.
 */
export function createWorkspacePolicy(options: WorkspaceOptions = {}): WorkspacePolicy {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const home = canonicalizePath(options.homedir ?? osHomedir(), { pathApi: api });
  const caseInsensitive = platform === "win32" || platform === "darwin";

  let root: string | null = null;
  let reason: string | null = null;
  const rootInput = options.root ?? env.ANDROID_MCP_WORKSPACE;
  if (rootInput) {
    const resolved = canonicalRoot(rootInput, api, home);
    if (resolved === FILESYSTEM_ROOT) {
      reason =
        "workspace-unconfigured: the filesystem root is not a project workspace; set ANDROID_MCP_WORKSPACE to the project root";
    } else if (resolved) {
      root = resolved;
    } else {
      reason =
        "workspace-unconfigured: ANDROID_MCP_WORKSPACE cannot be resolved; set it to an existing project root";
    }
  } else {
    reason =
      "workspace-unconfigured: set ANDROID_MCP_WORKSPACE to the project root or ANDROID_MCP_WORKSPACE_ROOTS to approved roots";
  }

  const extraInputs = [
    ...(options.extraRoots ?? []),
    ...(env.ANDROID_MCP_WORKSPACE_ROOTS ?? "").split(path.delimiter),
  ];
  const extraRoots: string[] = [];
  for (const input of extraInputs) {
    if (!input || !input.trim()) continue;
    const resolved = canonicalRoot(input, api, home);
    if (resolved && resolved !== FILESYSTEM_ROOT && !extraRoots.includes(resolved)) {
      extraRoots.push(resolved);
    }
  }

  const tempInput = options.tempRoot === null ? null : (options.tempRoot ?? osTmpdir());
  const tempRoot = tempInput ? canonicalizePath(tempInput, { pathApi: api }) : null;

  const roots: string[] = [];
  for (const candidate of [root, ...extraRoots, tempRoot]) {
    if (candidate && !roots.includes(candidate)) roots.push(candidate);
  }

  return Object.freeze({
    root,
    roots: Object.freeze(roots),
    extraRoots: Object.freeze(extraRoots),
    tempRoot,
    reason,
    platform,
    caseInsensitive,
    pathApi: api,
  });
}

/** True when target is the root itself or a descendant of root. */
export function isPathInside(
  root: string,
  target: string,
  opts: { pathApi?: path.PlatformPath; caseInsensitive?: boolean } = {},
): boolean {
  const api = opts.pathApi ?? path;
  const resolvedRoot = api.resolve(root);
  const resolvedTarget = api.resolve(target);
  const normalize = (value: string) => (opts.caseInsensitive ? value.toLowerCase() : value);

  // Compare whole path segments rather than a string prefix or
  // pathApi.relative: win32.relative is always case-insensitive, which would
  // ignore the requested case mode, and prefixes would accept "/work2" for
  // "/work".
  const rootParts = normalize(resolvedRoot)
    .split(api.sep)
    .filter((part, index, all) => {
      // Keep the leading empty segment for absolute POSIX paths and the empty
      // segment that follows a Windows drive or UNC prefix.
      return part.length > 0 || index === 0 || (index === 1 && all[0] === "");
    });
  const targetParts = normalize(resolvedTarget).split(api.sep);
  if (targetParts.length < rootParts.length) return false;
  for (let index = 0; index < rootParts.length; index += 1) {
    if (rootParts[index] !== targetParts[index]) return false;
  }
  return true;
}

/** Decide whether a target may be used for the requested operation. */
export function checkWorkspacePath(
  policy: WorkspacePolicy,
  target: string,
  operation: PathOperation,
): PathDecision {
  if (!policy || typeof target !== "string" || target.length === 0) {
    return { ok: false, reason: "invalid-path", operation };
  }
  const api = policy.pathApi ?? path;
  let candidate = target;
  if (!api.isAbsolute(candidate)) {
    if (!policy.root) {
      return { ok: false, reason: policy.reason ?? "workspace-unconfigured", operation };
    }
    candidate = api.join(policy.root, candidate);
  }

  const canonical = canonicalizePath(candidate, { pathApi: api });
  if (!canonical) return { ok: false, reason: "path-resolution-failed", operation };

  for (const root of policy.roots) {
    if (
      isPathInside(root, canonical, {
        pathApi: api,
        caseInsensitive: policy.caseInsensitive,
      })
    ) {
      return { ok: true, path: canonical, root, operation };
    }
  }
  return {
    ok: false,
    reason:
      policy.roots.length > 0 ? "outside-workspace" : (policy.reason ?? "workspace-unconfigured"),
    path: canonical,
    operation,
  };
}

function comparable(value: string, policy: WorkspacePolicy): string {
  return policy.caseInsensitive ? value.toLowerCase() : value;
}

/**
 * Create a single-use, request-bound approval for one canonical path outside
 * the workspace. Grants are immutable and expire; they cannot be replayed for
 * another path, another project or a later request.
 */
export function createPathGrant(opts: {
  policy: WorkspacePolicy;
  target: string;
  operation: PathOperation;
  requestId?: string;
  ttlMs?: number;
  now?: Date;
}): PathGrant {
  const api = opts.policy.pathApi ?? path;
  if (!opts.target) throw new Error("workspace grant requires a target path");
  const absolute = api.isAbsolute(opts.target)
    ? opts.target
    : api.join(opts.policy.root ?? api.resolve("."), opts.target);
  const canonical = canonicalizePath(absolute, { pathApi: api });
  if (!canonical) throw new Error("workspace grant target cannot be resolved");
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? 5 * 60_000)).toISOString();
  return Object.freeze({
    id: randomUUID(),
    requestId: opts.requestId ?? randomUUID(),
    path: canonical,
    operation: opts.operation,
    projectRoot: opts.policy.root,
    expiresAt,
  });
}

export function validatePathGrant(
  policy: WorkspacePolicy,
  grant: PathGrant,
  target: string,
  operation: PathOperation,
  opts: { requestId?: string; now?: Date } = {},
): PathDecision {
  if (!grant || typeof grant !== "object" || !Object.isFrozen(grant)) {
    return { ok: false, reason: "invalid-grant", operation };
  }
  if (grant.projectRoot !== policy.root) {
    return { ok: false, reason: "grant-project-mismatch", operation };
  }
  if (opts.requestId !== grant.requestId) {
    return { ok: false, reason: "grant-request-mismatch", operation };
  }
  const now = opts.now ?? new Date();
  if (now.getTime() > Date.parse(grant.expiresAt)) {
    return { ok: false, reason: "grant-expired", operation };
  }
  if (grant.operation !== operation) {
    return { ok: false, reason: "grant-operation-mismatch", operation };
  }
  const api = policy.pathApi ?? path;
  const absolute = api.isAbsolute(target)
    ? target
    : api.join(policy.root ?? api.resolve("."), target);
  const canonical = canonicalizePath(absolute, { pathApi: api });
  if (!canonical) return { ok: false, reason: "path-resolution-failed", operation };
  if (comparable(canonical, policy) !== comparable(grant.path, policy)) {
    return { ok: false, reason: "grant-target-mismatch", operation };
  }
  return { ok: true, path: canonical, operation };
}
