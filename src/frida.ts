import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, which } from "./util.js";

// Every adb/frida invocation here is interactive-ish (push, root, attach) and
// must fail loudly instead of hanging the MCP request forever.
const TIMEOUT = 60_000;

/** Where the pushed frida-server lives on the device. */
export const DEVICE_SERVER_PATH = "/data/local/tmp/frida-server";

/**
 * Private, application-specific state directory. Capture state records the
 * original device proxy and the owned mitmdump identity, so it must not live in
 * a shared predictable temp path.
 */
export const STATE_DIR =
  process.env.ANDROID_MCP_STATE_DIR ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "android-mcp")
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "android-mcp"));

/**
 * Versioned session record for the single mitmproxy capture. The env override
 * keeps tests and parallel harnesses off the production path.
 */
export const PIDFILE = process.env.ANDROID_MCP_PIDFILE ?? join(STATE_DIR, "net-capture.json");

/** Repo root as seen from src/ (tsx) or dist/ (compiled) — one level up. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adbArgs(deviceId?: string): string[] {
  return deviceId ? ["-s", deviceId] : [];
}

/** Windows venvs use Scripts\*.exe; POSIX venvs use bin/<name> (with exec bits). */
const IS_WIN = process.platform === "win32";
function vendoredCliPath(root: string, name: string): string {
  return IS_WIN
    ? join(root, ".toolchain", "python-venv", "Scripts", `${name}.exe`)
    : join(root, ".toolchain", "python-venv", "bin", name);
}

async function isExecutable(path: string): Promise<boolean> {
  // On Windows, fs.access X_OK degenerates to "file exists" — but the vendored
  // probe path already includes the .exe suffix, which IS the executable bit
  // the Windows venv layout provides. On POSIX the exec bit is meaningful.
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile();
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
 * Resolve a vendored CLI: `.toolchain/python-venv/{bin|Scripts}` when executable
 * (offline-first, wins over a stale PATH install), else PATH via `which`.
 */
async function resolveCli(root: string, name: string): Promise<string | null> {
  const vendored = vendoredCliPath(root, name);
  if (await isExecutable(vendored)) return vendored;
  return which(name);
}

export function resolveFridaCli(root: string): Promise<string | null> {
  return resolveCli(root, "frida");
}

export function resolveMitmDump(root: string): Promise<string | null> {
  // Tests and custom installations can point at a specific stub or binary.
  const override = process.env.ANDROID_MCP_MITMDUMP;
  if (override) return Promise.resolve(override);
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
    if (await isReadableFile(pinned)) return pinned;
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
  const sibling = join(dirname(cli), IS_WIN ? "frida-ps.exe" : "frida-ps");
  return (await isExecutable(sibling)) ? sibling : "frida-ps";
}

/**
 * Issue 77: ensure/reuse semantics. A healthy server on the selected device is
 * reused without root, push, kill or relaunch. Provisioning runs only when no
 * server responds, or when a managed server's version does not match the
 * bundled one. Calls are serialized per device serial; emulator A never blocks
 * or alters emulator B. Unmanaged processes are never killed.
 */
export interface EnsureServerResult {
  server: string;
  abi: string;
  serial: string;
  reused: boolean;
  managed: boolean;
  pid: string | null;
  version: string | null;
}

const deviceLocks = new Map<string, Promise<unknown>>();

function withDeviceLock<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const previous = deviceLocks.get(serial) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  deviceLocks.set(serial, current);
  return current.finally(() => {
    if (deviceLocks.get(serial) === current) deviceLocks.delete(serial);
  });
}

export async function resolveDeviceSerial(deviceId?: string): Promise<string> {
  if (deviceId) return deviceId;
  const r = await run("adb", ["get-serialno"], { timeout: TIMEOUT });
  const serial = r.stdout.trim();
  if (r.code !== 0 || !serial || serial === "unknown" || /error/i.test(serial)) {
    throw new Error(
      `could not resolve the selected ADB serial: ${(r.stderr || r.stdout).trim() || "adb get-serialno failed"} — ` +
        `pass deviceId explicitly when more than one device is attached`,
    );
  }
  return serial;
}

async function fridaProbe(ps: string, serial: string): Promise<boolean> {
  const check = await run(ps, ["-D", serial], { timeout: 5_000 });
  return check.code === 0;
}

async function serverPid(serial: string): Promise<string | null> {
  const r = await run("adb", [...adbArgs(serial), "shell", "pidof", "frida-server"], {
    timeout: TIMEOUT,
  });
  if (r.code !== 0) return null;
  const pid = r.stdout.trim().split(/\s+/)[0] ?? "";
  return /^\d+$/.test(pid) ? pid : null;
}

async function serverCommandLine(serial: string, pid: string): Promise<string | null> {
  const r = await run("adb", [...adbArgs(serial), "shell", "cat", `/proc/${pid}/cmdline`], {
    timeout: TIMEOUT,
  });
  return r.code === 0 ? r.stdout.replaceAll("\u0000", " ").trim() || null : null;
}

async function deployedServerVersion(serial: string): Promise<string | null> {
  const r = await run("adb", [...adbArgs(serial), "shell", `${DEVICE_SERVER_PATH} --version`], {
    timeout: TIMEOUT,
  });
  if (r.code !== 0) return null;
  const version = r.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return version ?? null;
}

async function killExactPid(serial: string, pid: string): Promise<void> {
  await run("adb", [...adbArgs(serial), "shell", "kill", pid], { timeout: TIMEOUT });
}

async function startManagedServer(serial: string): Promise<string | null> {
  const started = await run(
    "adb",
    [...adbArgs(serial), "shell", `nohup ${DEVICE_SERVER_PATH} >/dev/null 2>&1 & echo $!`],
    { timeout: TIMEOUT },
  );
  const pid = started.stdout
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^\d+$/.test(token))
    .pop();
  return pid ?? null;
}

/**
 * Root the selected device for system CA-store work. This is the shared root
 * path used by both Frida provisioning and net_capture, so capture startup does
 * not need to provision a Frida server just to become root.
 */
export async function ensureRoot(deviceId?: string): Promise<void> {
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
  const rootWaitMs = Number(process.env.ANDROID_MCP_ROOT_WAIT_MS ?? 2000);
  if (Number.isFinite(rootWaitMs) && rootWaitMs > 0) await sleep(rootWaitMs);
}

export async function ensureServer(deviceId?: string, root?: string): Promise<EnsureServerResult> {
  const base = root ?? REPO_ROOT;
  const serial = await resolveDeviceSerial(deviceId);

  return withDeviceLock(serial, async () => {
    const expectedVersion = await fridaVersion(base);
    const abi = await deviceAbi(serial);
    const asset = mapAbiToAsset(abi);
    const ps = await fridaPsCommand(base);

    const healthy = await fridaProbe(ps, serial);
    const pid = await serverPid(serial);
    const commandLine = pid ? await serverCommandLine(serial, pid) : null;
    const managed = Boolean(commandLine && commandLine.includes(DEVICE_SERVER_PATH));
    const version = managed ? await deployedServerVersion(serial) : null;
    const versionMismatch = Boolean(
      healthy && expectedVersion && version && version !== expectedVersion,
    );

    if (healthy && !versionMismatch) {
      return {
        server: DEVICE_SERVER_PATH,
        abi,
        serial,
        reused: true,
        managed,
        pid,
        version,
      };
    }

    if (versionMismatch && pid) {
      // Only the process whose command line is our deployed binary may be
      // replaced; the version check already proved it is ours.
      await killExactPid(serial, pid);
      await sleep(500);
    } else if (!healthy && pid) {
      if (!managed) {
        throw new Error(
          `unmanaged frida-server process ${pid} on ${serial} is not responding and does not ` +
            `match ${DEVICE_SERVER_PATH}; refusing to kill it — stop it manually or use a clean device`,
        );
      }
      await killExactPid(serial, pid);
      await sleep(500);
    }

    await ensureRoot(serial);

    const serverFile = await resolveServerFile(base, asset);
    const pushed = await run("adb", [...adbArgs(serial), "push", serverFile, DEVICE_SERVER_PATH], {
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
      [...adbArgs(serial), "shell", "chmod", "755", DEVICE_SERVER_PATH],
      { timeout: TIMEOUT },
    );
    if (chmod.code !== 0) {
      const detail = (chmod.stderr || chmod.stdout).trim() || "no output";
      throw new Error(`chmod 755 ${DEVICE_SERVER_PATH} failed: ${detail}`);
    }

    const newPid = await startManagedServer(serial);
    const deadline = Date.now() + 15_000;
    let last = "";
    for (;;) {
      const check = await run(ps, ["-D", serial], { timeout: 5_000 });
      if (check.code === 0) {
        return {
          server: DEVICE_SERVER_PATH,
          abi,
          serial,
          reused: false,
          managed: true,
          pid: newPid,
          version: expectedVersion,
        };
      }
      last = (check.stderr || check.stdout).trim();
      if (Date.now() >= deadline) break;
      await sleep(1000);
    }

    throw new Error(
      `frida-server is running at ${DEVICE_SERVER_PATH} (${asset}) but 'frida-ps -D ${serial}' ` +
        `cannot reach it: ${last || "no output"} — check the device is unlocked, the ` +
        `ABI matches (${abi}), and selinux did not deny the binary` +
        (newPid ? ` (started pid ${newPid})` : ""),
    );
  });
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
