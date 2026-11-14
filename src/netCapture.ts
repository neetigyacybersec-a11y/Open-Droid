// Issue 76: durable, device-bound net_capture sessions.
//
// The state record is the source of truth: exact ADB serial, the proxy value
// that existed before capture, the applied proxy, the owned mitmdump identity,
// HAR/log paths, port and an absolute expiry. Stop and recovery operate on that
// record, never on whichever device happens to be selected later.
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PIDFILE, ensureRoot, pidRunning, resolveDeviceSerial, resolveMitmDump } from "./frida.js";
import { run } from "./util.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MITM_CA_PATH = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
const DEVICE_CA_DIR = "/system/etc/security/cacerts";
/** Emulator NAT alias for the host loopback (physical devices need `adb reverse`). */
const EMULATOR_HOST_ALIAS = "10.0.2.2";
const HAR_WAIT_MS = 10_000;
const KILL_WAIT_MS = 2_000;
const STATE_VERSION = 1;

export interface NetCaptureArgs {
  action: "start" | "stop";
  deviceId?: string;
  port?: number;
  durationSec?: number;
}

export type ProxySetting = { kind: "unset" } | { kind: "set"; value: string };

export interface CaptureSession {
  version: typeof STATE_VERSION;
  sessionId: string;
  /** Exact serial selected at start; stop and recovery are bound to it. */
  serial: string;
  originalProxy: ProxySetting;
  appliedProxy: string;
  pid: number;
  /** Process start identity as reported by ps/CIM, when available. */
  processStart: string | null;
  port: number;
  har: string;
  log: string;
  startedAt: string;
  expiresAt: string;
  recovery?: { at: string; error: string; manualCommand: string };
}

interface LegacyCaptureState {
  pid: number;
  har: string;
  port?: number;
}

type StateRead =
  | { kind: "none" }
  | { kind: "session"; session: CaptureSession }
  | { kind: "legacy"; state: LegacyCaptureState }
  | { kind: "corrupt"; detail: string };

interface ProcessInfo {
  command: string | null;
  start: string | null;
}

type EndStatus = "stopped" | "already-exited" | "identity-mismatch" | "recovery-required";

interface EndResult {
  status: EndStatus;
  har: string;
  harWritten: boolean;
  warnings: string[];
}

export interface RecoveryResult {
  status: EndStatus | "none" | "active" | "superseded";
  text: string;
}

function isProxySetting(value: unknown): value is ProxySetting {
  if (!value || typeof value !== "object") return false;
  const v = value as { kind?: unknown; value?: unknown };
  return v.kind === "unset" || (v.kind === "set" && typeof v.value === "string");
}

function isCaptureSession(value: unknown): value is CaptureSession {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === STATE_VERSION &&
    typeof s.sessionId === "string" &&
    typeof s.serial === "string" &&
    isProxySetting(s.originalProxy) &&
    typeof s.appliedProxy === "string" &&
    typeof s.pid === "number" &&
    Number.isInteger(s.pid) &&
    s.pid > 0 &&
    (s.processStart === null || typeof s.processStart === "string") &&
    typeof s.port === "number" &&
    typeof s.har === "string" &&
    typeof s.log === "string" &&
    typeof s.startedAt === "string" &&
    typeof s.expiresAt === "string" &&
    Number.isFinite(Date.parse(s.expiresAt))
  );
}

function readLegacy(raw: string): LegacyCaptureState | null {
  const [pidLine = "", harLine = "", portLine = ""] = raw.split("\n");
  const pid = Number.parseInt(pidLine.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const port = Number.parseInt(portLine.trim(), 10);
  return {
    pid,
    har: harLine.trim(),
    port: Number.isInteger(port) && port > 0 ? port : undefined,
  };
}

async function readCaptureState(): Promise<StateRead> {
  let raw: string;
  try {
    raw = await readFile(PIDFILE, "utf8");
  } catch {
    return { kind: "none" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const legacy = readLegacy(raw);
    return legacy ? { kind: "legacy", state: legacy } : { kind: "corrupt", detail: "not JSON" };
  }
  if (isCaptureSession(parsed)) return { kind: "session", session: parsed };
  const legacy = readLegacy(raw);
  if (legacy) return { kind: "legacy", state: legacy };
  return { kind: "corrupt", detail: "unrecognized state schema" };
}

async function writeCaptureState(session: CaptureSession): Promise<void> {
  const dir = dirname(PIDFILE);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700).catch(() => undefined);
  const tmp = `${PIDFILE}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, PIDFILE);
  if (process.platform !== "win32") await chmod(PIDFILE, 0o600).catch(() => undefined);
}

async function removeCaptureState(sessionId?: string): Promise<boolean> {
  const current = await readCaptureState();
  if (sessionId && current.kind === "session" && current.session.sessionId !== sessionId) {
    return false;
  }
  await rm(PIDFILE, { force: true });
  return true;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// --- device proxy -----------------------------------------------------------

function proxyRestoreArgs(setting: ProxySetting): string[] {
  return setting.kind === "unset"
    ? ["shell", "settings", "delete", "global", "http_proxy"]
    : ["shell", "settings", "put", "global", "http_proxy", setting.value];
}

function manualProxyCommand(serial: string, setting: ProxySetting): string {
  return `adb -s ${serial} ${proxyRestoreArgs(setting).join(" ")}`;
}

async function readDeviceProxy(
  serial: string,
): Promise<{ ok: true; setting: ProxySetting } | { ok: false; detail: string }> {
  const r = await run("adb", ["-s", serial, "shell", "settings", "get", "global", "http_proxy"], {
    timeout: 30_000,
  });
  if (r.code !== 0) {
    return { ok: false, detail: (r.stderr || r.stdout).trim() || "no output" };
  }
  const raw = r.stdout.trim();
  if (!raw || raw === "null") return { ok: true, setting: { kind: "unset" } };
  return { ok: true, setting: { kind: "set", value: raw } };
}

async function applyDeviceProxy(serial: string, value: string): Promise<string | null> {
  const r = await run(
    "adb",
    ["-s", serial, "shell", "settings", "put", "global", "http_proxy", value],
    { timeout: 30_000 },
  );
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || "no output";
}

async function restoreDeviceProxy(serial: string, setting: ProxySetting): Promise<string | null> {
  const r = await run("adb", ["-s", serial, ...proxyRestoreArgs(setting)], { timeout: 30_000 });
  return r.code === 0 ? null : (r.stderr || r.stdout).trim() || "no output";
}

// --- process identity -------------------------------------------------------

async function captureProcessInfo(pid: number): Promise<ProcessInfo> {
  if (process.platform === "win32") {
    const r = await run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($p) { Write-Output ($p.CreationDate.ToString('o') + '|' + $p.CommandLine) }`,
      ],
      { timeout: 15_000 },
    );
    if (r.code !== 0 || !r.stdout.trim()) return { command: null, start: null };
    const line = r.stdout.trim().split("\n").pop() ?? "";
    const split = line.indexOf("|");
    if (split < 0) return { command: line.trim() || null, start: null };
    return {
      start: line.slice(0, split).trim() || null,
      command: line.slice(split + 1).trim() || null,
    };
  }
  const command = await run("ps", ["-ww", "-p", String(pid), "-o", "command="], {
    timeout: 15_000,
  });
  const start = await run("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
    timeout: 15_000,
  });
  return {
    command: command.code === 0 ? command.stdout.trim() || null : null,
    start: start.code === 0 ? start.stdout.trim() || null : null,
  };
}

function captureCommandMatches(session: CaptureSession, command: string): boolean {
  const normalized = command.replaceAll("\\", "/");
  const har = session.har.replaceAll("\\", "/");
  return (
    normalized.includes(har) &&
    /mitmdump/i.test(normalized) &&
    normalized.includes(String(session.port))
  );
}

function identityMatches(session: CaptureSession, info: ProcessInfo): boolean {
  if (!info.command || !captureCommandMatches(session, info.command)) return false;
  if (session.processStart && info.start && session.processStart !== info.start) return false;
  return true;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidRunning(pid)) return true;
    await sleep(100);
  }
  return !pidRunning(pid);
}

interface TerminateResult {
  signalled: boolean;
  ended: boolean;
  reason?: "identity-mismatch" | "still-running";
}

async function terminateOwned(session: CaptureSession): Promise<TerminateResult> {
  if (!pidRunning(session.pid)) return { signalled: false, ended: true };
  const info = await captureProcessInfo(session.pid);
  if (!identityMatches(session, info)) {
    return { signalled: false, ended: false, reason: "identity-mismatch" };
  }
  try {
    process.kill(session.pid, "SIGTERM");
  } catch {
    // Died between the liveness check and the signal.
  }
  let ended = await waitForExit(session.pid, HAR_WAIT_MS);
  if (!ended) {
    try {
      process.kill(session.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    ended = await waitForExit(session.pid, KILL_WAIT_MS);
  }
  return { signalled: true, ended, reason: ended ? undefined : "still-running" };
}

// --- session lock and auto-stop --------------------------------------------

let captureQueue: Promise<unknown> = Promise.resolve();

function withCaptureLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = captureQueue.catch(() => undefined).then(fn);
  captureQueue = next;
  return next;
}

let autoStopTimer: NodeJS.Timeout | null = null;
let autoStopSessionId: string | null = null;

function cancelAutoStop(sessionId?: string): void {
  if (sessionId && autoStopSessionId !== sessionId) return;
  if (autoStopTimer) clearTimeout(autoStopTimer);
  autoStopTimer = null;
  autoStopSessionId = null;
}

function scheduleAutoStop(session: CaptureSession): void {
  cancelAutoStop();
  const remaining = Date.parse(session.expiresAt) - Date.now();
  if (!Number.isFinite(remaining)) return;
  const timer = setTimeout(
    () => {
      autoStopTimer = null;
      autoStopSessionId = null;
      void stopSessionById(session.sessionId).catch(() => undefined);
    },
    Math.max(0, remaining),
  );
  timer.unref();
  autoStopTimer = timer;
  autoStopSessionId = session.sessionId;
}

// --- ending a session -------------------------------------------------------

async function recordRecoveryFailure(
  session: CaptureSession,
  error: string,
): Promise<string | null> {
  const current = await readCaptureState();
  if (current.kind !== "session" || current.session.sessionId !== session.sessionId) {
    return "session record changed while recording the recovery failure";
  }
  const updated: CaptureSession = {
    ...current.session,
    recovery: {
      at: new Date().toISOString(),
      error,
      manualCommand: manualProxyCommand(session.serial, session.originalProxy),
    },
  };
  try {
    await writeCaptureState(updated);
    return null;
  } catch (e: any) {
    return `could not persist recovery details: ${e?.message ?? String(e)}`;
  }
}

async function finishSession(session: CaptureSession): Promise<EndResult> {
  cancelAutoStop(session.sessionId);
  const warnings: string[] = [];
  const term = await terminateOwned(session);
  if (term.reason === "identity-mismatch") {
    warnings.push(
      `pid ${session.pid} no longer matches capture session ${session.sessionId}; ` +
        `the unrelated process was not signalled`,
    );
  }
  if (term.reason === "still-running") {
    warnings.push(
      `mitmdump pid ${session.pid} did not exit after SIGTERM/SIGKILL; ` +
        `the session record is retained so a later stop can retry`,
    );
  }
  if (!session.har || !(await fileExists(session.har))) {
    warnings.push(`HAR not written at ${session.har} — check ${session.log}`);
  }

  const restoreError = await restoreDeviceProxy(session.serial, session.originalProxy);
  let status: EndStatus;
  if (term.reason === "identity-mismatch") status = "identity-mismatch";
  else if (term.reason === "still-running") status = "recovery-required";
  else status = term.signalled ? "stopped" : "already-exited";

  if (restoreError) {
    status = "recovery-required";
    warnings.push(
      `failed to restore the original HTTP proxy on ${session.serial}: ${restoreError}; ` +
        `run manually: ${manualProxyCommand(session.serial, session.originalProxy)}`,
    );
    const recordWarning = await recordRecoveryFailure(session, restoreError);
    if (recordWarning) warnings.push(recordWarning);
  } else if (term.reason !== "still-running") {
    await removeCaptureState(session.sessionId);
  }

  return {
    status,
    har: session.har,
    harWritten: Boolean(session.har && (await fileExists(session.har))),
    warnings,
  };
}

async function stopSessionById(sessionId: string): Promise<EndResult | null> {
  return withCaptureLock(async () => {
    const current = await readCaptureState();
    if (current.kind !== "session" || current.session.sessionId !== sessionId) return null;
    return finishSession(current.session);
  });
}

function renderEnd(session: CaptureSession, result: EndResult): string {
  const lines: string[] = [];
  if (result.status === "recovery-required") {
    lines.push("status=recovery-required");
    lines.push(`device=${session.serial}`);
    lines.push(`session=${session.sessionId}`);
    lines.push(`HAR: ${result.har}${result.harWritten ? "" : " (not written)"}`);
  } else if (result.status === "identity-mismatch") {
    lines.push(
      `capture stop: status=identity-mismatch; pid ${session.pid} was not signalled ` +
        `because its command no longer matches this session`,
    );
    lines.push(
      `device=${session.serial}; HAR: ${result.har}${result.harWritten ? "" : " (not written)"}`,
    );
  } else {
    lines.push(
      result.harWritten
        ? `capture stopped (session ${session.sessionId}, device ${session.serial}); HAR: ${result.har}`
        : `capture stopped (session ${session.sessionId}, device ${session.serial}); ` +
            `HAR: ${result.har} (not yet written — check ${session.log})`,
    );
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

function stateErrorMessage(kind: "corrupt"): string {
  return (
    `capture state at ${PIDFILE} is ${kind}; refusing to guess which device or proxy it ` +
    `belongs to. Inspect the file and clear the device proxy manually before retrying`
  );
}

// --- CA installation (best effort, unchanged contract) ---------------------

async function installMitmCa(serial: string, warnings: string[]): Promise<string | null> {
  if (!(await fileExists(MITM_CA_PATH))) {
    warnings.push(`mitmproxy CA not found at ${MITM_CA_PATH}`);
    return null;
  }
  const hashed = await run(
    "openssl",
    ["x509", "-inform", "PEM", "-subject_hash_old", "-in", MITM_CA_PATH, "-noout"],
    { timeout: 30_000 },
  );
  const hash = hashed.stdout.split("\n")[0]?.trim();
  if (hashed.code !== 0 || !hash) {
    warnings.push(
      `could not hash mitmproxy CA with openssl: ${(hashed.stderr || hashed.stdout).trim() || "no output"}`,
    );
    return null;
  }
  const name = `${hash}.0`;
  const remote = `${DEVICE_CA_DIR}/${name}`;
  const base = ["-s", serial];

  const remounted = await run("adb", [...base, "remount"], { timeout: 60_000 });
  if (remounted.code !== 0) {
    warnings.push(
      `adb remount failed, CA not installed: ${(remounted.stderr || remounted.stdout).trim() || "no output"}`,
    );
    return null;
  }
  const pushed = await run("adb", [...base, "push", MITM_CA_PATH, remote], { timeout: 60_000 });
  if (pushed.code !== 0) {
    warnings.push(
      `CA push to ${remote} failed: ${(pushed.stderr || pushed.stdout).trim() || "no output"}`,
    );
    return null;
  }
  const chmodResult = await run("adb", [...base, "shell", "chmod", "644", remote], {
    timeout: 30_000,
  });
  if (chmodResult.code !== 0) {
    warnings.push(
      `chmod 644 ${remote} failed: ${(chmodResult.stderr || chmodResult.stdout).trim() || "no output"}`,
    );
    return null;
  }
  return remote;
}

// --- start ------------------------------------------------------------------

async function prepareForStart(warnings: string[], requestedPort: number): Promise<void> {
  const current = await readCaptureState();
  if (current.kind === "none") return;
  if (current.kind === "corrupt") throw new Error(stateErrorMessage("corrupt"));
  if (current.kind === "legacy") {
    if (pidRunning(current.state.pid)) {
      throw new Error(
        `net_capture busy: capture running (pidfile ${PIDFILE}, port ${current.state.port ?? requestedPort}) — ` +
          `the legacy record has no device binding; stop it manually first`,
      );
    }
    await rm(PIDFILE, { force: true });
    warnings.push(
      "discarded a legacy capture record that stored no device or original proxy; " +
        "verify the device proxy manually if that capture changed it",
    );
    return;
  }

  const session = current.session;
  const expired = Date.parse(session.expiresAt) <= Date.now();
  if (pidRunning(session.pid) && !expired) {
    throw new Error(`net_capture busy: capture running (pidfile ${PIDFILE}, port ${session.port})`);
  }
  const ended = await finishSession(session);
  warnings.push(
    `previous session ${session.sessionId} (${session.serial}) was cleaned up: ${ended.status}`,
  );
  if (ended.status === "recovery-required") {
    throw new Error(
      `cannot start a new capture: session ${session.sessionId} still requires recovery — ` +
        `${ended.warnings.join("; ")}`,
    );
  }
}

/** Rollback after a partial start, using the exact child object we spawned. */
async function stopSpawnedChild(
  child: import("node:child_process").ChildProcess | undefined,
  pid: number,
): Promise<void> {
  try {
    child?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitForExit(pid, KILL_WAIT_MS)) return;
  try {
    child?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForExit(pid, KILL_WAIT_MS);
}

export async function handleNetCapture(args: NetCaptureArgs) {
  if (args.action === "stop") {
    return withCaptureLock(async () => {
      const current = await readCaptureState();
      if (current.kind === "none") {
        return { content: [{ type: "text" as const, text: "no active capture (no state file)" }] };
      }
      if (current.kind === "corrupt") throw new Error(stateErrorMessage("corrupt"));
      if (current.kind === "legacy") {
        const legacy = current.state;
        if (pidRunning(legacy.pid)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `status=recovery-required\n` +
                  `legacy capture state at ${PIDFILE} has no device or process identity; ` +
                  `refusing to signal pid ${legacy.pid}. Inspect the record, stop the process ` +
                  `manually, and clear the device proxy by hand. HAR: ${legacy.har}`,
              },
            ],
            isError: true,
          };
        }
        await rm(PIDFILE, { force: true });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `no active capture (legacy record for pid ${legacy.pid} was already dead; removed). ` +
                `No proxy was changed because the record has no device binding. HAR: ${legacy.har}`,
            },
          ],
        };
      }

      const session = current.session;
      if (args.deviceId && args.deviceId !== session.serial) {
        throw new Error(
          `capture session ${session.sessionId} is bound to ${session.serial}, not ` +
            `${args.deviceId}; refusing to stop or restore a different device — ` +
            `retry with deviceId=${session.serial} or omit deviceId`,
        );
      }
      const result = await finishSession(session);
      return {
        content: [{ type: "text" as const, text: renderEnd(session, result) }],
        isError: result.status === "recovery-required",
      };
    });
  }

  const port = args.port ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port}: expected an integer in 1..65535`);
  }
  const durationSec = args.durationSec ?? 30;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 86400) {
    throw new Error(`invalid durationSec ${durationSec}: expected a number in 1..86400 seconds`);
  }

  return withCaptureLock(async () => {
    const warnings: string[] = [];
    await prepareForStart(warnings, port);

    const serial = await resolveDeviceSerial(args.deviceId);
    const original = await readDeviceProxy(serial);
    if (!original.ok) {
      throw new Error(
        `could not read the existing HTTP proxy on ${serial}: ${original.detail} — ` +
          `refusing to start without a value to restore`,
      );
    }

    const mitm = await resolveMitmDump(REPO_ROOT);
    if (!mitm) throw new Error("mitmdump not found — run 'make setup' (vendors python-venv)");

    let rooted = false;
    try {
      await ensureRoot(serial);
      rooted = true;
    } catch (e: any) {
      warnings.push(`device root/profile skipped: ${e?.message ?? String(e)}`);
    }

    const sessionId = randomUUID();
    const har = join(tmpdir(), `android-mcp-mitm-${sessionId}.har`);
    const log = `${har}.log`;
    const appliedProxy = `${EMULATOR_HOST_ALIAS}:${port}`;

    const { spawn } = await import("node:child_process");
    const fd = openSync(log, "a");
    let child: import("node:child_process").ChildProcess | undefined;
    let pid: number | undefined;
    try {
      pid = await new Promise<number>((resolve, reject) => {
        const spawned = spawn(mitm, ["-p", String(port), "--set", `hardump=${har}`], {
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        child = spawned;
        spawned.once("spawn", () => {
          spawned.unref();
          resolve(spawned.pid as number);
        });
        spawned.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
      });
    } finally {
      closeSync(fd);
    }
    if (!pid) throw new Error("failed to spawn mitmdump");

    await sleep(500);
    if (!pidRunning(pid)) {
      let tail = "";
      try {
        tail = (await readFile(log, "utf8")).trim().split("\n").slice(-5).join("\n");
      } catch {
        // No log; the generic message below is enough.
      }
      throw new Error(
        `mitmdump exited immediately (port ${port} already in use?): ${tail || "no output"}`,
      );
    }

    const info = await captureProcessInfo(pid);
    const now = Date.now();
    const session: CaptureSession = {
      version: STATE_VERSION,
      sessionId,
      serial,
      originalProxy: original.setting,
      appliedProxy,
      pid,
      processStart: info.start,
      port,
      har,
      log,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + durationSec * 1000).toISOString(),
    };

    try {
      await writeCaptureState(session);
    } catch (e) {
      await stopSpawnedChild(child, pid);
      throw e;
    }

    let caInstalled: string | null = null;
    if (rooted) {
      if (!(await fileExists(MITM_CA_PATH))) {
        warnings.push(`mitmproxy CA was not created at ${MITM_CA_PATH}`);
      } else {
        caInstalled = await installMitmCa(serial, warnings);
      }
    }

    const setError = await applyDeviceProxy(serial, appliedProxy);
    if (setError) {
      await stopSpawnedChild(child, pid);
      const restoreError = await restoreDeviceProxy(serial, original.setting);
      let message =
        `failed to set device HTTP proxy: ${setError} — ` +
        `check 'adb devices' and that the device is rooted`;
      if (restoreError) {
        const recordWarning = await recordRecoveryFailure(session, restoreError);
        message +=
          `\nstatus=recovery-required\ndevice=${serial}\n` +
          `failed to restore the original proxy: ${restoreError}\n` +
          `run manually: ${manualProxyCommand(serial, original.setting)}`;
        if (recordWarning) message += `\nwarning: ${recordWarning}`;
      } else {
        await removeCaptureState(session.sessionId);
      }
      throw new Error(message);
    }

    scheduleAutoStop(session);

    const details = [
      `proxy set to ${appliedProxy} (emulator host alias; on a physical ` +
        `device use 'adb reverse tcp:${port} tcp:${port}' with http_proxy 127.0.0.1:${port})`,
      ...(caInstalled
        ? [`CA installed at ${caInstalled}`]
        : rooted
          ? [
              "CA not installed; on API 34+ the system CA store lives in the Conscrypt APEX, so system-trust install may fail — see docs/troubleshooting.md (APEX overlay/Magisk)",
            ]
          : [
              "device not rooted; system CA not installed (a rootable google_apis image is required)",
            ]),
      `auto-stop at ${session.expiresAt} (in ${durationSec}s) — the HAR is flushed when mitmdump exits`,
      "if this MCP process exits, the persisted session is recovered on the next start or server startup: " +
        `the owned mitmdump is stopped and ${serial} is restored to ` +
        (original.setting.kind === "unset" ? "an unset proxy" : `'${original.setting.value}'`),
      ...warnings.map((w) => `warning: ${w}`),
    ];

    return {
      content: [
        {
          type: "text" as const,
          text: [`capture started (session ${sessionId}, pid ${pid}, har ${har})`, ...details].join(
            "\n",
          ),
        },
      ],
    };
  });
}

// --- recovery ---------------------------------------------------------------

/**
 * Reconcile a persisted session with the current process. Called on MCP startup
 * and available to tests. An unexpired session stays active (and gets a fresh
 * in-process timer); an expired session is stopped, its owned mitmdump is
 * terminated after identity verification, and the original proxy is restored.
 */
export async function recoverCaptureSession(): Promise<RecoveryResult> {
  return withCaptureLock(async () => {
    const current = await readCaptureState();
    if (current.kind === "none") return { status: "none", text: "no capture session" };
    if (current.kind === "corrupt") {
      return { status: "recovery-required", text: stateErrorMessage("corrupt") };
    }
    if (current.kind === "legacy") {
      if (pidRunning(current.state.pid)) {
        return {
          status: "recovery-required",
          text:
            `legacy capture state at ${PIDFILE} has no device or process identity; ` +
            `refusing to signal pid ${current.state.pid}. Inspect the record and clear the ` +
            `device proxy manually. HAR: ${current.state.har}`,
        };
      }
      await rm(PIDFILE, { force: true });
      return {
        status: "already-exited",
        text:
          `discarded a dead legacy capture record for pid ${current.state.pid}; ` +
          `no device proxy was changed because no device was recorded`,
      };
    }

    const session = current.session;
    if (Date.now() < Date.parse(session.expiresAt)) {
      scheduleAutoStop(session);
      return {
        status: "active",
        text:
          `capture session ${session.sessionId} on ${session.serial} remains active ` +
          `until ${session.expiresAt}`,
      };
    }
    const result = await finishSession(session);
    return { status: result.status, text: renderEnd(session, result) };
  });
}
