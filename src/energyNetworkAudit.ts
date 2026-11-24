// ISSUE-57: package-scoped energy, wake locks, alarms and network-usage audit
// from device dumps (dumpsys). Read-only. Unsupported metrics are reported as
// unavailable with their limitation, never guessed from interface-level data.
import { run, type RunResult } from "./services/process-runner.js";
import { adbArgs } from "./services/adb-client.js";
import { validatePackageName } from "./util.js";

export interface BatteryInfo {
  available: boolean;
  level: number | null;
  charging: boolean;
  health: string | null;
}

export interface JobsInfo {
  available: boolean;
  items: string[];
}

export interface AlarmsInfo {
  available: boolean;
  items: string[];
}

export interface WakeLocksInfo {
  available: boolean;
  items: string[];
  note: string;
}

export interface NetworkInfo {
  available: boolean;
  packageScoped: boolean;
  items: string[];
  note: string;
}

export interface EnergyOkReport {
  status: "ok";
  packageName: string;
  deviceId: string | undefined;
  battery: BatteryInfo;
  jobs: JobsInfo;
  alarms: AlarmsInfo;
  wakeLocks: WakeLocksInfo;
  network: NetworkInfo;
  summary: string;
}

export interface EnergyErrorReport {
  status: "error";
  packageName: string;
  reason: string;
}

export type EnergyReport = EnergyOkReport | EnergyErrorReport;

export interface EnergyAuditInput {
  packageName: string;
  deviceId?: string;
  runner?: (cmd: string, args: string[]) => Promise<RunResult>;
}

const SHELL_TIMEOUT_MS = 30_000;
const PACKAGE_SCOPED_NETWORK_NOTE =
  "dumpsys netstats exposes interface-level counters; per-app accounting requires an Android 13+ dumpsummary or logcat-based scoping — reported as unavailable in v1";

const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED-TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED-TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED-TOKEN]"],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[REDACTED-EMAIL]"],
  [/\b(?:password|passwd|secret|token|api[_-]?key|passcode)\s*[:=]\s*\S+/gi, "[REDACTED]"],
  [/\b[a-z-]+\.(?:internal|corp)\b/gi, "[REDACTED-HOST]"],
  [
    /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168\.\d{1,3})(?:\.\d{1,3}){0,2}\b/g,
    "[REDACTED-HOST]",
  ],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function parseBattery(stdout: string): BatteryInfo {
  const level = /level[:=]\s*(\d+)/.exec(stdout)?.[1];
  const plugged = /plugged[:=]\s*(\d+)/.exec(stdout)?.[1];
  return {
    available: stdout.trim().length > 0,
    level: level === undefined ? null : Number(level),
    charging: plugged !== undefined && Number(plugged) !== 0,
    health: /health[:=]\s*(\w+)/.exec(stdout)?.[1] ?? null,
  };
}

function parsePackageLines(stdout: string, pkg: string, limit: number): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes(pkg))
    .slice(0, limit)
    .map(redact);
}

function parseJobs(stdout: string, pkg: string): JobsInfo {
  const items = parsePackageLines(stdout, pkg, 25);
  return { available: items.length > 0, items };
}

function parseAlarms(stdout: string, pkg: string): AlarmsInfo {
  const items = parsePackageLines(stdout, pkg, 25);
  return { available: items.length > 0, items };
}

function parseWakeLocks(stdout: string): WakeLocksInfo {
  const items = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toUpperCase().includes("WAKE_LOCK"))
    .slice(0, 25)
    .map(redact);
  return {
    available: items.length > 0,
    items,
    note: "dumpsys power is global; per-app attribution is not scoped in v1",
  };
}

function parseNetwork(stdout: string): NetworkInfo {
  const items = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10)
    .map(redact);
  return {
    available: items.length > 0,
    packageScoped: false,
    items,
    note: PACKAGE_SCOPED_NETWORK_NOTE,
  };
}

function summarize(report: EnergyOkReport): string {
  const parts = [`package=${report.packageName}`];
  if (report.battery.level !== null) parts.push(`battery=${report.battery.level}%`);
  if (report.battery.charging) parts.push("charging");
  if (report.jobs.available) parts.push(`jobs=${report.jobs.items.length}`);
  if (report.alarms.available) parts.push(`alarms=${report.alarms.items.length}`);
  if (report.wakeLocks.available) parts.push(`wakeLocks=${report.wakeLocks.items.length}`);
  parts.push("network: interface-level (package-scoped unavailable in v1)");
  return parts.join("; ");
}

/** Audit the package: read-only dumps, never writes or publishes. */
export async function auditEnergyNetwork(input: EnergyAuditInput): Promise<EnergyReport> {
  const pkg = input.packageName;
  if (!validatePackageName(pkg))
    return { status: "error", packageName: pkg, reason: "invalid package name" };
  const runner = input.runner ?? ((cmd, args) => run(cmd, args, { timeout: SHELL_TIMEOUT_MS }));
  const shell = async (cmds: string[]): Promise<string> => {
    const res = await runner("adb", [...adbArgs(input.deviceId), "shell", ...cmds]);
    return res.stdout ?? res.stderr ?? "";
  };
  const dumps = {
    battery: parseBattery(await shell(["dumpsys", "battery"])),
    jobs: parseJobs(await shell(["dumpsys", "jobstats", pkg]), pkg),
    alarms: parseAlarms(await shell(["dumpsys", "alarm"]), pkg),
    wakeLocks: parseWakeLocks(await shell(["dumpsys", "power"])),
    network: parseNetwork(await shell(["dumpsys", "netstats"])),
  };
  const report: EnergyOkReport = {
    status: "ok",
    packageName: pkg,
    deviceId: input.deviceId,
    summary: "",
    ...dumps,
  };
  report.summary = summarize(report);
  return report;
}

export function renderEnergyReport(report: EnergyReport): string {
  if (report.status === "error") return `status=error\nreason=${report.reason}`;
  return JSON.stringify(report, null, 2).slice(0, 12_000);
}
