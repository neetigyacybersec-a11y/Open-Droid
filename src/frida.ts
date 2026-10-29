import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "./util.js";

// Every adb/frida invocation here is interactive-ish (push, root, attach) and
// must fail loudly instead of hanging the MCP request forever.
const TIMEOUT = 60_000;

/** Where the pushed frida-server lives on the device. */
export const DEVICE_SERVER_PATH = "/data/local/tmp/frida-server";

/** pidfile for the single-session mitmproxy capture (Task 7). */
export const PIDFILE = join(tmpdir(), "android-mcp-mitm.pid");

/** Repo root as seen from src/ (tsx) or dist/ (compiled) — one level up. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adbArgs(deviceId?: string): string[] {
  return deviceId ? ["-s", deviceId] : [];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a device ABI (`getprop ro.product.cpu.abi`) to the frida-server release
 * asset suffix. GitHub ships `android-x86_64` / `android-arm64`, not `arm64-v8a`.
 */
export function mapAbiToAsset(abi: string): string {
  switch (abi) {
    case "x86_64":
      return "x86_64";
    case "arm64-v8a":
      return "arm64";
    default:
      throw new Error("unsupported device ABI: " + abi);
  }
}

/** Only userdebug/eng images allow `adb root`; everything else is nonrootable. */
export function parseBuildType(prop: string): "rootable" | "nonrootable" {
  const t = prop.trim();
  return t === "userdebug" || t === "eng" ? "rootable" : "nonrootable";
}

/**
 * Resolve a vendored CLI: `.toolchain/python-venv/bin/<name>` when executable
 * (offline-first, wins over a stale PATH install), else PATH via `which`.
 */
async function resolveCli(root: string, name: string): Promise<string | null> {
  const vendored = join(root, ".toolchain", "python-venv", "bin", name);
  if (await isExecutable(vendored)) return vendored;
  return which(name);
}

export function resolveFridaCli(root: string): Promise<string | null> {
  return resolveCli(root, "frida");
}

export function resolveMitmDump(root: string): Promise<string | null> {
  return resolveCli(root, "mitmdump");
}

/** Pinned FRIDA_VERSION from versions.env, when readable. */
async function fridaVersion(root: string): Promise<string | null> {
  try {
    const txt = await readFile(join(root, "versions.env"), "utf8");
    const m = txt.match(/^\s*FRIDA_VERSION\s*=\s*(\S+)\s*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Locate the vendored frida-server binary for a mapped asset, preferring the
 * pinned version from versions.env and falling back to any vendored build.
 * Error messages name the repo-relative path so `make setup` is the obvious fix.
 */
async function resolveServerFile(root: string, asset: string): Promise<string> {
  const dir = join(root, ".toolchain", "frida");
  const version = await fridaVersion(root);
  if (version) {
    const pinned = join(dir, `frida-server-${version}-android-${asset}`);
    if (await isFile(pinned)) return pinned;
  }

  const entries = await readdir(dir).catch(() => [] as string[]);
  const candidate = entries
    .filter(
      (f) => f.startsWith("frida-server-") && f.endsWith(`-android-${asset}`) && !f.endsWith(".xz"),
    )
    .sort()
    .pop();
  if (candidate) return join(dir, candidate);

  const expected = `.toolchain/frida/frida-server-${version ?? "<version>"}-android-${asset}`;
  throw new Error(
    `frida-server for ABI '${asset}' not found at ${expected} — run 'make setup' ` +
      `(vendors frida-server for x86_64 and arm64)`,
  );
}

async function getprop(deviceId: string | undefined, prop: string): Promise<string> {
  const r = await run("adb", [...adbArgs(deviceId), "shell", "getprop", prop], {
    timeout: TIMEOUT,
  });
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim() || "no output";
    throw new Error(
      `adb shell getprop ${prop} failed on ${deviceId ?? "default device"}: ${detail} — ` +
        `check 'adb devices' (booted emulator or authorized physical device)`,
    );
  }
  return r.stdout.trim();
}

export function deviceAbi(deviceId?: string): Promise<string> {
  return getprop(deviceId, "ro.product.cpu.abi");
}

export function deviceBuildType(deviceId?: string): Promise<string> {
  return getprop(deviceId, "ro.build.type");
}

/** frida-ps next to the resolved frida CLI, else the PATH one. */
async function fridaPsCommand(root: string): Promise<string> {
  const cli = await resolveFridaCli(root);
  if (!cli) {
    throw new Error("frida CLI not found — run 'make setup' (vendors python-venv)");
  }
  const sibling = join(dirname(cli), "frida-ps");
  return (await isExecutable(sibling)) ? sibling : "frida-ps";
}

/**
 * Make frida-server usable on the selected device: root the (google_apis)
 * image, push the ABI-matched server, start it, and confirm with frida-ps.
 * Idempotent per boot: stale servers are killed before the restart.
 */
export async function ensureServer(
  deviceId?: string,
  root?: string,
): Promise<{ server: string; abi: string }> {
  const base = root ?? REPO_ROOT;

  const buildType = await deviceBuildType(deviceId);
  if (parseBuildType(buildType) === "nonrootable") {
    throw new Error(
      `device image '${buildType}' cannot adb root (google_apis images required; ` +
        `default fallback images are not rootable — re-run make setup)`,
    );
  }

  const rooted = await run("adb", [...adbArgs(deviceId), "root"], { timeout: TIMEOUT });
  if (rooted.code !== 0) {
    const detail = (rooted.stderr || rooted.stdout).trim() || "no output";
    throw new Error(
      `adb root failed on ${deviceId ?? "default device"}: ${detail} — ` +
        `use a google_apis system image (re-run make setup)`,
    );
  }
  // adbd restarts and briefly drops the transport after `adb root`.
  await sleep(2000);

  const abi = await deviceAbi(deviceId);
  const asset = mapAbiToAsset(abi);
  const serverFile = await resolveServerFile(base, asset);

  const pushed = await run("adb", [...adbArgs(deviceId), "push", serverFile, DEVICE_SERVER_PATH], {
    timeout: TIMEOUT,
  });
  if (pushed.code !== 0) {
    const detail = (pushed.stderr || pushed.stdout).trim() || "no output";
    throw new Error(
      `failed to push ${serverFile} to ${DEVICE_SERVER_PATH}: ${detail} — ` +
        `check 'adb devices' and free space on /data/local/tmp`,
    );
  }

  const chmod = await run(
    "adb",
    [...adbArgs(deviceId), "shell", "chmod", "755", DEVICE_SERVER_PATH],
    { timeout: TIMEOUT },
  );
  if (chmod.code !== 0) {
    const detail = (chmod.stderr || chmod.stdout).trim() || "no output";
    throw new Error(`chmod 755 ${DEVICE_SERVER_PATH} failed: ${detail}`);
  }

  // Kill a stale server from a previous boot/run, then start detached.
  await run("adb", [...adbArgs(deviceId), "shell", "pkill -f frida-server || true"], {
    timeout: TIMEOUT,
  });
  await run(
    "adb",
    [...adbArgs(deviceId), "shell", `nohup ${DEVICE_SERVER_PATH} >/dev/null 2>&1 &`],
    { timeout: TIMEOUT },
  );

  const fridaPs = await fridaPsCommand(base);
  const deadline = Date.now() + 15_000;
  let last = "";
  for (;;) {
    const check = await run(fridaPs, ["-U"], { timeout: TIMEOUT });
    if (check.code === 0) return { server: DEVICE_SERVER_PATH, abi };
    last = (check.stderr || check.stdout).trim();
    if (Date.now() >= deadline) break;
    await sleep(1000);
  }

  throw new Error(
    `frida-server is running at ${DEVICE_SERVER_PATH} (${asset}) but 'frida-ps -U' ` +
      `cannot reach it: ${last || "no output"} — check the device is unlocked, the ` +
      `ABI matches (${abi}), and selinux did not deny the binary`,
  );
}

/** True when `pid` is a live process (EPERM means alive but not ours). */
export function pidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}
