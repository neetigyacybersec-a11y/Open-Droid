import { z } from "zod";
import { closeSync, constants, openSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  run,
  which,
  tmpDir,
  readBase64,
  cleanup,
  validateGradleTask,
  validatePackageName,
} from "./util.js";
import {
  PIDFILE,
  ensureServer,
  pidRunning,
  resolveFridaCli,
  resolveMitmDump,
} from "./frida.js";

export const ToolSchemas = {
  envCheck: z.object({}),
  gradle: z.object({
    projectPath: z.string().describe("Absolute path to the Gradle project root"),
    task: z.string().describe("Gradle task, e.g. :app:assembleDebug"),
    args: z.array(z.string()).optional().describe("Extra gradle args"),
    offline: z.boolean().optional().default(false).describe("Run with --offline (vendored toolchain)"),
  }),
  adbDevices: z.object({}),
  adbScreenshot: z.object({
    deviceId: z.string().optional(),
    outputPath: z.string().optional().describe("Where to save PNG; defaults to temp"),
  }),
  adbInstall: z.object({
    apkPath: z.string(),
    deviceId: z.string().optional(),
  }),
  adbLaunch: z.object({
    packageName: z.string(),
    activity: z.string().optional(),
    deviceId: z.string().optional(),
  }),
  emulatorList: z.object({}),
  emulatorBoot: z.object({
    avdName: z.string(),
    headless: z.boolean().optional().default(true),
    gpu: z.string().optional().default("swiftshader_indirect"),
  }),
  maestroRun: z.object({
    flowPath: z.string(),
    deviceId: z.string().optional(),
  }),
  composePreviewRender: z.object({
    projectPath: z.string(),
    previewFqn: z.string().optional().describe("Fully qualified @Preview composable"),
  }),
  skillsList: z.object({}),
  skillsSearch: z.object({ query: z.string() }),
  sdkmanagerInstall: z.object({
    packages: z.array(z.string()).describe("sdkmanager package ids"),
  }),
  adbShell: z.object({
    deviceId: z.string().optional(),
    command: z.string().min(1).describe("Raw shell command, e.g. dumpsys activity top"),
    timeoutSec: z.number().max(600).optional().default(60),
  }),
  adbLogcat: z.object({
    deviceId: z.string().optional(),
    tag: z.string().optional().describe("Filter: adb logcat tag selector, e.g. MyActivity:E or *:W"),
    pattern: z.string().optional().describe("Regex applied to captured log text"),
    durationSec: z
      .number()
      .max(86400)
      .optional()
      .default(10)
      .describe("Seconds to wait before dumping (logcat -c then -d)"),
    clear: z.boolean().optional().default(true).describe("Clear the device log buffer before waiting"),
  }),
  runtimeDump: z.object({
    deviceId: z.string().optional(),
    kind: z.enum(["activity", "service", "package", "meminfo"]),
    packageName: z.string().optional(),
  }),
  fridaPs: z.object({ deviceId: z.string().optional() }),
  fridaHook: z.object({
    packageName: z.string(),
    deviceId: z.string().optional(),
    script: z.string().optional().describe("Inline Frida JS; takes precedence over scriptPath"),
    scriptPath: z.string().optional(),
    spawn: z.boolean().optional().default(true).describe("true: spawn+resume via -f; false: attach to running process by name"),
    durationSec: z.number().max(86400).optional().default(30),
  }),
  fridaTraceMethods: z.object({
    packageName: z.string(),
    className: z.string().describe("Exact class or regex-resolvable FQN, e.g. com.example.app.Crypto"),
    methodRegex: z.string().optional().default(".*"),
    deviceId: z.string().optional(),
    durationSec: z.number().max(86400).optional().default(30),
  }),
  netCapture: z.object({
    action: z.enum(["start", "stop"]),
    deviceId: z.string().optional(),
    port: z.number().optional().default(8080),
    durationSec: z
      .number()
      .max(86400)
      .optional()
      .default(30)
      .describe("Seconds of traffic to collect before auto-stop (start)"),
  }),

  // ---- Build & test ----
  gradleTest: z.object({ projectPath: z.string(), args: z.array(z.string()).optional(), offline: z.boolean().optional().default(false) }),
  gradleLint: z.object({ projectPath: z.string(), args: z.array(z.string()).optional(), offline: z.boolean().optional().default(false) }),
  gradleDependencies: z.object({ projectPath: z.string(), configuration: z.string().optional().default("debugRuntimeClasspath") }),
  buildVariant: z.object({ projectPath: z.string(), variant: z.string(), args: z.array(z.string()).optional(), offline: z.boolean().optional().default(false) }),
  baselineProfileGenerate: z.object({ projectPath: z.string(), module: z.string().optional().default(":app"), args: z.array(z.string()).optional() }),
  adbPush: z.object({ deviceId: z.string().optional(), localPath: z.string(), remotePath: z.string() }),
  adbPull: z.object({ deviceId: z.string().optional(), remotePath: z.string(), localPath: z.string().optional() }),
  adbRm: z.object({ deviceId: z.string().optional(), remotePath: z.string() }),
  adbUninstall: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbClearData: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbForceStop: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbReboot: z.object({ deviceId: z.string().optional() }),
  adbScreenrecord: z.object({ deviceId: z.string().optional(), durationSec: z.number().optional().default(10), outputPath: z.string().optional() }),
  adbInput: z.object({ deviceId: z.string().optional(), action: z.enum(["tap","swipe","text","keyevent"]), x: z.number().optional(), y: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(), text: z.string().optional(), keycode: z.string().optional() }),
  adbDeepLink: z.object({ deviceId: z.string().optional(), uri: z.string(), packageName: z.string().optional() }),
  adbBroadcast: z.object({ deviceId: z.string().optional(), action: z.string(), extras: z.array(z.string()).optional() }),
  adbServiceStart: z.object({ deviceId: z.string().optional(), component: z.string() }),
  adbWifi: z.object({ deviceId: z.string().optional(), action: z.enum(["tcpip","connect","disconnect"]), port: z.number().optional().default(5555), host: z.string().optional() }),
  adbBattery: z.object({ deviceId: z.string().optional() }),
  logcatFiltered: z.object({ deviceId: z.string().optional(), tag: z.string().optional(), packageName: z.string().optional(), pattern: z.string().optional(), durationSec: z.number().optional().default(10), clear: z.boolean().optional().default(true) }),
  anrCheck: z.object({ deviceId: z.string().optional() }),
  crashSummary: z.object({ deviceId: z.string().optional(), durationSec: z.number().optional().default(10) }),
  uiDump: z.object({ deviceId: z.string().optional(), outputPath: z.string().optional() }),
  composeRecomposition: z.object({ deviceId: z.string().optional(), packageName: z.string().optional() }),
  layoutBounds: z.object({ deviceId: z.string().optional(), enabled: z.boolean().default(true) }),
  avdCreate: z.object({ avdName: z.string(), systemImage: z.string(), device: z.string().optional().default("pixel_6") }),
  avdDelete: z.object({ avdName: z.string() }),
  avdWipe: z.object({ avdName: z.string() }),
  emulatorSnapshot: z.object({ deviceId: z.string().optional(), action: z.enum(["save","load","list"]), name: z.string().optional() }),
  apkInfo: z.object({ apkPath: z.string() }),
  apkDecompile: z.object({ apkPath: z.string(), outputDir: z.string().optional(), tool: z.enum(["jadx","apktool"]).optional().default("jadx") }),
  manifestInspect: z.object({ apkPath: z.string() }),
  nativeLibs: z.object({ apkPath: z.string() }),
  dexStrings: z.object({ apkPath: z.string(), pattern: z.string().optional() }),
  instrumentedTest: z.object({ projectPath: z.string(), module: z.string().optional().default(":app"), testFilter: z.string().optional(), device: z.string().optional(), offline: z.boolean().optional().default(false), args: z.array(z.string()).optional() }),
  testCoverage: z.object({ projectPath: z.string(), module: z.string().optional().default(":app") }),
  macrobenchmark: z.object({ projectPath: z.string(), module: z.string().optional().default(":macrobenchmark"), args: z.array(z.string()).optional() }),
  perfettoTrace: z.object({ deviceId: z.string().optional(), durationSec: z.number().optional().default(10), outputPath: z.string().optional() }),
  memoryProfile: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  startupTime: z.object({ deviceId: z.string().optional(), packageName: z.string(), iterations: z.number().optional().default(5) }),
  adbParallel: z.object({ command: z.string(), deviceIds: z.array(z.string()).optional() }),
  apkServe: z.object({ action: z.enum(["start","stop"]), port: z.number().optional().default(8000), dir: z.string().optional() }),
};

export type ToolName = keyof typeof ToolSchemas;

async function adbBase(deviceId?: string): Promise<string[]> {
  return deviceId ? ["-s", deviceId] : [];
}

export async function handleEnvCheck() {
  const checks = await Promise.all([
    which("java"),
    which("javac"),
    which("gradle"),
    which("adb"),
    which("emulator"),
    which("sdkmanager"),
    which("maestro"),
    which("compose-preview"),
    which("android"),
  ]);
  const lines = [
    `java: ${checks[0] ?? "MISSING"}`,
    `javac: ${checks[1] ?? "MISSING"}`,
    `gradle: ${checks[2] ?? "MISSING"}`,
    `adb: ${checks[3] ?? "MISSING"}`,
    `emulator: ${checks[4] ?? "MISSING"}`,
    `sdkmanager: ${checks[5] ?? "MISSING"}`,
    `maestro: ${checks[6] ?? "MISSING"}`,
    `compose-preview: ${checks[7] ?? "MISSING"}`,
    `android CLI: ${checks[8] ?? "MISSING"}`,
    `ANDROID_HOME: ${process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "unset"}`,
    `JAVA_HOME: ${process.env.JAVA_HOME ?? "unset"}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export async function handleGradle(args: z.infer<typeof ToolSchemas.gradle>) {
  if (!validateGradleTask(args.task)) {
    return { content: [{ type: "text" as const, text: "Invalid gradle task name." }], isError: true };
  }
  const gradleArgs = [args.task, ...(args.offline ? ["--offline"] : []), ...(args.args ?? [])];
  const r = await run("gradle", gradleArgs, { cwd: args.projectPath, timeout: 600_000 });
  const out = `exit=${r.code}\n--- stdout ---\n${r.stdout.slice(-8000)}\n--- stderr ---\n${r.stderr.slice(-4000)}`;
  return { content: [{ type: "text" as const, text: out }], isError: r.code !== 0 };
}

export async function handleAdbDevices() {
  const r = await run("adb", ["devices", "-l"]);
  return { content: [{ type: "text" as const, text: r.stdout || r.stderr }], isError: r.code !== 0 };
}

export async function handleAdbScreenshot(args: z.infer<typeof ToolSchemas.adbScreenshot>) {
  const dir = await tmpDir();
  const local = args.outputPath ?? join(dir, "screen.png");
  const remote = "/sdcard/screen.png";
  const base = await adbBase(args.deviceId);
  let r = await run("adb", [...base, "shell", "screencap", "-p", remote]);
  if (r.code !== 0) {
    await cleanup(dir);
    return { content: [{ type: "text" as const, text: `screencap failed: ${r.stderr}` }], isError: true };
  }
  r = await run("adb", [...base, "pull", remote, local]);
  if (r.code !== 0) {
    await cleanup(dir);
    return { content: [{ type: "text" as const, text: `pull failed: ${r.stderr}` }], isError: true };
  }
  const b64 = await readBase64(local);
  await cleanup(dir);
  return {
    content: [
      { type: "image" as const, data: b64, mimeType: "image/png" },
      { type: "text" as const, text: `Saved screenshot to ${local}` },
    ],
  };
}

export async function handleAdbInstall(args: z.infer<typeof ToolSchemas.adbInstall>) {
  const base = await adbBase(args.deviceId);
  const r = await run("adb", [...base, "install", "-r", args.apkPath], { timeout: 300_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}

export async function handleAdbLaunch(args: z.infer<typeof ToolSchemas.adbLaunch>) {
  if (!validatePackageName(args.packageName)) {
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  }
  const base = await adbBase(args.deviceId);
  const target = args.activity ? `${args.packageName}/${args.activity}` : args.packageName;
  const r = await run("adb", [...base, "shell", "monkey", "-p", args.packageName, "-c", "android.intent.category.LAUNCHER", "1"]);
  // fallback: am start
  let out = r.stdout + r.stderr;
  if (r.code !== 0) {
    const r2 = await run("adb", [...base, "shell", "am", "start", "-n", target]);
    out += "\n" + r2.stdout + r2.stderr;
    return { content: [{ type: "text" as const, text: out }], isError: r2.code !== 0 };
  }
  return { content: [{ type: "text" as const, text: out }] };
}

export async function handleEmulatorList() {
  const r = await run("emulator", ["-list-avds"]);
  return { content: [{ type: "text" as const, text: r.stdout || r.stderr }], isError: r.code !== 0 };
}

export async function handleEmulatorBoot(args: z.infer<typeof ToolSchemas.emulatorBoot>) {
  // spawn detached
  const { spawn: sp } = await import("node:child_process");
  const gpu = args.gpu ?? "swiftshader_indirect";
  const child = sp(
    "emulator",
    ["-avd", args.avdName, ...(args.headless ? ["-no-window", "-no-audio"] : []), "-gpu", gpu],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  return {
    content: [{ type: "text" as const, text: `Booted AVD ${args.avdName} (pid ${child.pid}). Use adb wait-for-device.` }],
  };
}

export async function handleMaestroRun(args: z.infer<typeof ToolSchemas.maestroRun>) {
  const base = args.deviceId ? ["--device", args.deviceId] : [];
  const r = await run("maestro", ["test", ...base, args.flowPath], { timeout: 600_000 });
  return { content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(-12000) }], isError: r.code !== 0 };
}

export async function handleComposePreviewRender(args: z.infer<typeof ToolSchemas.composePreviewRender>) {
  const cli = await which("compose-preview");
  if (!cli) {
    return {
      content: [{ type: "text" as const, text: "compose-preview CLI not found. Install compose-ai-tools first (see report)." }],
      isError: true,
    };
  }
  const argsArr = ["render", "--project", args.projectPath];
  if (args.previewFqn) argsArr.push("--preview", args.previewFqn);
  const r = await run(cli, argsArr, { cwd: args.projectPath, timeout: 600_000 });
  return { content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(-12000) }], isError: r.code !== 0 };
}

export async function handleSkillsList() {
  const cli = await which("android");
  if (cli) {
    const r = await run(cli, ["skills", "list"]);
    if (r.code === 0) return { content: [{ type: "text" as const, text: r.stdout }] };
  }
  // fallback: try npx android-skills-mcp? just report
  return {
    content: [{ type: "text" as const, text: "Android CLI not found. Install via https://developer.android.com/tools/agents/android-cli/download, or use android-skills-mcp MCP server directly." }],
  };
}

export async function handleSkillsSearch(args: z.infer<typeof ToolSchemas.skillsSearch>) {
  const cli = await which("android");
  if (cli) {
    const r = await run(cli, ["skills", "search", args.query]);
    if (r.code === 0) return { content: [{ type: "text" as const, text: r.stdout }] };
  }
  return {
    content: [{ type: "text" as const, text: `Android CLI not found; cannot search skills for "${args.query}".` }],
  };
}

export async function handleSdkmanagerInstall(args: z.infer<typeof ToolSchemas.sdkmanagerInstall>) {
  const cli = await which("sdkmanager");
  if (!cli) {
    return { content: [{ type: "text" as const, text: "sdkmanager not found. Set ANDROID_HOME and install command-line tools." }], isError: true };
  }
  const r = await run(cli, args.packages, { timeout: 600_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const OUTPUT_MAX_CHARS = 40_000;

/**
 * Cap captured adb output at OUTPUT_MAX_CHARS, appending a marker that reports the
 * original size. Without the marker a huge `dumpsys`/`cat` looks complete while its
 * tail is silently gone.
 */
export function capOutput(text: string, max = OUTPUT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated: ${text.length} chars total]` : text;
}

export async function handleAdbShell(args: z.infer<typeof ToolSchemas.adbShell>) {
  const timeoutMs = Math.max(1_000, (args.timeoutSec ?? 60) * 1000);
  const base = await adbBase(args.deviceId);
  const r = await run("adb", [...base, "shell", args.command], { timeout: timeoutMs });
  const out = `exit=${r.code}\n--- stdout ---\n${capOutput(r.stdout)}\n--- stderr ---\n${capOutput(r.stderr)}`;
  return { content: [{ type: "text" as const, text: out }], isError: r.code !== 0 };
}

const LOGCAT_MAX_LINES = 4_000;

export async function handleAdbLogcat(args: z.infer<typeof ToolSchemas.adbLogcat>) {
  const base = await adbBase(args.deviceId);
  const notes: string[] = [];

  if (args.clear !== false) {
    const cleared = await run("adb", [...base, "logcat", "-c"], { timeout: 60_000 });
    if (cleared.code !== 0) notes.push(`logcat -c failed: ${cleared.stderr.trim()}`);
  }

  const waitMs = Math.max(0, (args.durationSec ?? 10) * 1000);
  if (waitMs > 0) await sleep(waitMs);

  const r = await run("adb", [...base, "logcat", "-d", "-v", "time", ...(args.tag ? [args.tag] : [])], {
    timeout: 120_000,
  });
  if (r.code !== 0) {
    const err = [`logcat -d failed (exit=${r.code})`, r.stderr.trim(), ...notes].filter(Boolean).join("\n");
    return { content: [{ type: "text" as const, text: err }], isError: true };
  }

  const allLines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
  let lines = allLines;
  if (args.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, "m");
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Invalid pattern regex: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
    lines = allLines.filter((l) => re.test(l));
  }

  const truncated = lines.length > LOGCAT_MAX_LINES;
  const body = truncated ? lines.slice(-LOGCAT_MAX_LINES) : lines;
  const header = [
    `total=${allLines.length} matched=${lines.length} shown=${body.length}` +
      (truncated ? ` (last ${LOGCAT_MAX_LINES})` : ""),
    ...(args.pattern ? [`pattern=${args.pattern}`] : []),
    ...(args.tag ? [`tag=${args.tag}`] : []),
    ...notes,
  ];
  return {
    content: [{ type: "text" as const, text: [...header, "--- logcat ---", ...body].join("\n") }],
  };
}

export async function handleRuntimeDump(args: z.infer<typeof ToolSchemas.runtimeDump>) {
  const wantsPackage = args.kind === "package" || args.kind === "meminfo";
  if (args.packageName && !validatePackageName(args.packageName)) {
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  }
  const base = await adbBase(args.deviceId);
  const dumpArgs = ["shell", "dumpsys", args.kind];
  const ignored = args.packageName && !wantsPackage;
  if (wantsPackage && args.packageName) dumpArgs.push(args.packageName);
  const r = await run("adb", [...base, ...dumpArgs], { timeout: 120_000 });
  const head = `cmd=adb ${base.join(" ")} ${dumpArgs.join(" ")}`.replace(/\s+/g, " ").trim();
  const note = ignored ? `\nnote=packageName ignored for kind=${args.kind}` : "";
  const out = `${head}${note}\nexit=${r.code}\n--- stdout ---\n${capOutput(r.stdout)}\n--- stderr ---\n${capOutput(r.stderr)}`;
  return { content: [{ type: "text" as const, text: out }], isError: r.code !== 0 };
}

/** Repo root as seen from src/ (tsx) or dist/ (compiled) — one level up in both cases. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const HOOK_METHOD_SCRIPT = join(REPO_ROOT, "frida-scripts", "hook-method.js");

async function requireFridaCli(): Promise<string> {
  const cli = await resolveFridaCli(REPO_ROOT);
  if (!cli) throw new Error("frida CLI not found — run 'make setup' (vendors python-venv)");
  return cli;
}

/** `frida-ps` next to the resolved frida CLI (offline venv), else the PATH one. */
async function fridaPsPath(cli: string): Promise<string> {
  const sibling = join(dirname(cli), "frida-ps");
  try {
    await access(sibling, constants.X_OK);
    return sibling;
  } catch {
    return "frida-ps";
  }
}

function fridaDeviceArgs(deviceId?: string): string[] {
  return deviceId ? ["-D", deviceId] : ["-U"];
}

export async function handleFridaPs(args: z.infer<typeof ToolSchemas.fridaPs>) {
  const cli = await requireFridaCli();
  const server = await ensureServer(args.deviceId, REPO_ROOT);
  const ps = await fridaPsPath(cli);
  const deviceArgs = fridaDeviceArgs(args.deviceId);
  const r = await run(ps, [...deviceArgs, "-a", "-i"], { timeout: 60_000 });
  const header = [
    `server=${server.server} (${server.abi})`,
    `cmd=frida-ps ${deviceArgs.join(" ")} -a -i`,
    `exit=${r.code}`,
  ];
  const out = [...header, "--- stdout ---", capOutput(r.stdout), "--- stderr ---", r.stderr].join(
    "\n",
  );
  return { content: [{ type: "text" as const, text: out }], isError: r.code !== 0 };
}

interface FridaScriptRun {
  packageName: string;
  deviceId?: string;
  source: string;
  spawn?: boolean;
  durationSec?: number;
}

/**
 * Write the script to a temp file and run frida for a duration-derived budget.
 * Frida has no "trace for N seconds" flag, so the timeout kill is how a live
 * session normally ends; that specific case is reported as success.
 */
async function runFridaScript(o: FridaScriptRun) {
  const cli = await requireFridaCli();
  // Hooking spawns/attaches on the device, so provision frida-server first.
  // ensureServer is idempotent and surfaces ABI/rootability failures early.
  const server = await ensureServer(o.deviceId, REPO_ROOT);
  const spawn = o.spawn !== false;
  const durationSec = o.durationSec ?? 30;
  const target = [
    ...fridaDeviceArgs(o.deviceId),
    ...(spawn ? ["-f", o.packageName] : [o.packageName]),
  ];
  const dir = await tmpDir("android-mcp-frida-");
  const scriptFile = join(dir, "hook.js");
  const timeoutMs = Math.max(1, durationSec) * 1000 + 15_000;
  const started = Date.now();
  try {
    await writeFile(scriptFile, o.source, "utf8");
    const r = await run(cli, [...target, "-l", scriptFile], { timeout: timeoutMs });
    const budgetKill = r.code !== 0 && Date.now() - started >= timeoutMs - 1_000;
    const header = [
      `cmd=frida ${[...target, "-l", "<tmp>/hook.js"].join(" ")}`,
      `server=${server.server} (${server.abi})`,
      `durationSec=${durationSec}` +
        (budgetKill ? " (session killed at the duration budget; expected for live traces)" : ""),
      `exit=${r.code}`,
    ];
    const out = [
      ...header,
      "--- stdout ---",
      capOutput(r.stdout),
      "--- stderr ---",
      r.stderr.trim(),
    ].join("\n");
    return {
      content: [{ type: "text" as const, text: out }],
      isError: r.code !== 0 && !budgetKill,
    };
  } finally {
    await cleanup(dir);
  }
}

async function readHookSource(args: { script?: string; scriptPath?: string }): Promise<string> {
  if (args.script && args.script.trim().length > 0) return args.script;
  if (!args.scriptPath) {
    throw new Error("frida_hook needs a hook script: pass 'script' (inline JS) or 'scriptPath'");
  }
  try {
    return await readFile(args.scriptPath, "utf8");
  } catch (e: any) {
    throw new Error(`failed to read scriptPath '${args.scriptPath}': ${e?.message ?? String(e)}`);
  }
}

export async function handleFridaHook(args: z.infer<typeof ToolSchemas.fridaHook>) {
  const source = await readHookSource(args);
  return runFridaScript({
    packageName: args.packageName,
    deviceId: args.deviceId,
    source,
    spawn: args.spawn,
    durationSec: args.durationSec,
  });
}

export async function handleFridaTraceMethods(args: z.infer<typeof ToolSchemas.fridaTraceMethods>) {
  let lib: string;
  try {
    lib = await readFile(HOOK_METHOD_SCRIPT, "utf8");
  } catch (e: any) {
    throw new Error(
      `built-in trace script not found at frida-scripts/hook-method.js: ${e?.message ?? String(e)}`,
    );
  }
  // JSON.stringify keeps an odd className/regex from breaking out of the JS literal.
  const config = `var CONFIG = ${JSON.stringify({
    className: args.className,
    methodRegex: args.methodRegex ?? ".*",
    maxLen: 256,
  })};\n`;
  return runFridaScript({
    packageName: args.packageName,
    deviceId: args.deviceId,
    source: config + lib,
    spawn: true,
    durationSec: args.durationSec,
  });
}

// --- net_capture: one mitmdump session + device proxy/CA profile -------------

const MITM_CA_PATH = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
const DEVICE_CA_DIR = "/system/etc/security/cacerts";
/** Emulator NAT alias for the host loopback (physical devices need `adb reverse`). */
const EMULATOR_HOST_ALIAS = "10.0.2.2";
const HAR_WAIT_MS = 10_000;
// Tracks the in-process auto-stop timer so a manual `stop` can cancel it and
// a stale timer from a previous capture cannot clobber a later one (H1).
let activeAutoStopTimer: NodeJS.Timeout | null = null;
let activeAutoStopPid: number | null = null;

interface CaptureState {
  pid: number;
  /** Absolute path of the HAR file mitmdump flushes on exit. */
  har: string;
  /** Port the running capture is listening on (if recorded). */
  port?: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pidfile holds two lines: the mitmdump pid and the HAR path. Keeping the
 * HAR path here means `stop` can find it without scanning the temp directory
 * for a stale capture's output. The first line stays a plain pid, so callers
 * that only need liveness can parse it with parseInt.
 */
async function readCaptureState(): Promise<CaptureState | null> {
  let raw: string;
  try {
    raw = await readFile(PIDFILE, "utf8");
  } catch {
    return null;
  }
  const [pidLine = "", harLine = "", portLine = ""] = raw.split("\n");
  const pid = Number.parseInt(pidLine.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const port = Number.parseInt(portLine.trim(), 10);
  return { pid, har: harLine.trim(), port: Number.isInteger(port) && port > 0 ? port : undefined };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (path && (await fileExists(path))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

async function setDeviceProxy(
  deviceId: string | undefined,
  value: string,
  timeout: number
): Promise<{ code: number; detail: string }> {
  const base = await adbBase(deviceId);
  const r = await run(
    "adb",
    [...base, "shell", "settings", "put", "global", "http_proxy", value],
    { timeout }
  );
  return { code: r.code, detail: (r.stderr || r.stdout).trim() };
}

/** Best-effort: a failed clear only leaves the device pointing at a dead proxy. */
async function clearDeviceProxy(deviceId: string | undefined): Promise<string | null> {
  const cleared = await setDeviceProxy(deviceId, ":0", 30_000);
  return cleared.code === 0
    ? null
    : `failed to clear device HTTP proxy: ${cleared.detail || "no output"}`;
}

/**
 * Install the mitmproxy CA into the system store so apps trust intercepted
 * TLS. Requires a rooted/remountable image; every failure is a warning because
 * on API 34+ the system CA store is in the Conscrypt APEX, so this may need an overlay. Returns the installed name.
 */
async function installMitmCa(
  deviceId: string | undefined,
  warnings: string[]
): Promise<string | null> {
  if (!(await fileExists(MITM_CA_PATH))) {
    warnings.push(`mitmproxy CA not found at ${MITM_CA_PATH}`);
    return null;
  }

  // Android keys the store by the OpenSSL subject hash, not by filename.
  const hashed = await run(
    "openssl",
    ["x509", "-inform", "PEM", "-subject_hash_old", "-in", MITM_CA_PATH, "-noout"],
    { timeout: 30_000 }
  );
  const hash = hashed.stdout.split("\n")[0]?.trim();
  if (hashed.code !== 0 || !hash) {
    warnings.push(
      `could not hash mitmproxy CA with openssl: ${(hashed.stderr || hashed.stdout).trim() || "no output"}`
    );
    return null;
  }

  const name = `${hash}.0`;
  const remote = `${DEVICE_CA_DIR}/${name}`;
  const base = await adbBase(deviceId);

  const remounted = await run("adb", [...base, "remount"], { timeout: 60_000 });
  if (remounted.code !== 0) {
    warnings.push(
      `adb remount failed, CA not installed: ${(remounted.stderr || remounted.stdout).trim() || "no output"}`
    );
    return null;
  }

  const pushed = await run("adb", [...base, "push", MITM_CA_PATH, remote], {
    timeout: 60_000,
  });
  if (pushed.code !== 0) {
    warnings.push(
      `CA push to ${remote} failed: ${(pushed.stderr || pushed.stdout).trim() || "no output"}`
    );
    return null;
  }

  const chmod = await run("adb", [...base, "shell", "chmod", "644", remote], {
    timeout: 30_000,
  });
  if (chmod.code !== 0) {
    warnings.push(
      `chmod 644 ${remote} failed: ${(chmod.stderr || chmod.stdout).trim() || "no output"}`
    );
    return null;
  }

  return remote;
}

/** Guard against the auto-stop timer and an explicit stop racing each other. */
const stopInFlight = new Set<number>();

/**
 * SIGTERM the capture, wait up to 10s for mitmdump to flush the HAR, clear the
 * device proxy, and drop the pidfile. Used by both `stop` and the auto-stop
 * timer so a timed-out capture does not leave a stale pidfile/proxy behind.
 */
async function stopCapture(
  state: CaptureState,
  deviceId: string | undefined
): Promise<{ written: boolean; warnings: string[]; har: string }> {
  if (stopInFlight.has(state.pid)) {
    return {
      written: false,
      warnings: ["capture stop already in progress"],
      har: state.har,
    };
  }
  // Cancel any pending auto-stop timer for this capture so a manual stop does
  // not race with a later stale timer (H1).
  if (activeAutoStopPid === state.pid && activeAutoStopTimer) {
    clearTimeout(activeAutoStopTimer);
    activeAutoStopTimer = null;
    activeAutoStopPid = null;
  }
  stopInFlight.add(state.pid);
  try {
    if (pidRunning(state.pid)) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        // Died between the liveness check and the signal; nothing to do.
      }
    }
    const written = state.har ? await waitForFile(state.har, HAR_WAIT_MS) : false;
    // Guard against a stale auto-stop timer (or a duplicate stop) clobbering
    // a newer capture that has since taken over the pidfile (H1).
    const current = await readCaptureState();
    if (!current || current.pid !== state.pid) {
      return {
        written,
        warnings: ["capture superseded; no proxy/pidfile changes made"],
        har: state.har,
      };
    }
    const warnings: string[] = [];
    const clearWarning = await clearDeviceProxy(deviceId);
    if (clearWarning) warnings.push(clearWarning);
    await rm(PIDFILE, { force: true });
    return { written, warnings, har: state.har };
  } finally {
    stopInFlight.delete(state.pid);
  }
}

export async function handleNetCapture(args: z.infer<typeof ToolSchemas.netCapture>) {
  if (args.action === "stop") {
    const state = await readCaptureState();
    if (!state) {
      return { content: [{ type: "text" as const, text: "no active capture (no pidfile)" }] };
    }
    if (!pidRunning(state.pid)) {
      // A dead pid means the capture crashed or was killed externally; clear
      // the proxy it left behind so device traffic is not stuck on a dead port.
      await rm(PIDFILE, { force: true });
      await clearDeviceProxy(args.deviceId);
      return {
        content: [
          { type: "text" as const, text: `no active capture (stale pidfile removed); HAR: ${state.har}` },
        ],
      };
    }
    const { written, warnings, har } = await stopCapture(state, args.deviceId);
    const text = [
      written
        ? `capture stopped; HAR: ${har}`
        : `capture stopped; HAR: ${har} (not yet written — check the mitmdump log)`,
      ...warnings.map((w) => `warning: ${w}`),
    ].join("\n");
    return { content: [{ type: "text" as const, text }] };
  }

  const existing = await readCaptureState();
  if (existing && pidRunning(existing.pid)) {
    const runningPort = existing.port ?? args.port;
    throw new Error(
      `net_capture busy: capture running (pidfile ${PIDFILE}, port ${runningPort})`
    );
  }
  // A pidfile whose process is gone is debris from a crashed/killed run.
  if (existing) await rm(PIDFILE, { force: true });

  const port = args.port ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port}: expected an integer in 1..65535`);
  }
  const durationSec = args.durationSec ?? 30;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 86400) {
    throw new Error(`invalid durationSec ${durationSec}: expected a number in 1..86400 seconds`);
  }

  const mitm = await resolveMitmDump(REPO_ROOT);
  if (!mitm) throw new Error("mitmdump not found — run 'make setup' (vendors python-venv)");

  const har = join(tmpdir(), `android-mcp-mitm-${Date.now()}.har`);
  const warnings: string[] = [];

  // Root the device first: it is needed for the system CA store and is also
  // what the Frida tools provision. A failure here does not block HTTP capture.
  let rooted = false;
  try {
    await ensureServer(args.deviceId, REPO_ROOT);
    rooted = true;
  } catch (e: any) {
    warnings.push(`device root/profile skipped: ${e?.message ?? String(e)}`);
  }

  // Detached mitmdump: it must outlive this request, so the MCP server never
  // waits on the session. stdio goes to a sidecar log for startup diagnostics.
  const { spawn } = await import("node:child_process");
  const logPath = `${har}.log`;
  const fd = openSync(logPath, "a");
  let pid: number | undefined;
  try {
    pid = await new Promise<number>((resolve, reject) => {
      const child = spawn(mitm, ["-p", String(port), "--set", `hardump=${har}`], {
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.once("spawn", () => {
        child.unref();
        resolve(child.pid as number);
      });
      child.once("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  } finally {
    closeSync(fd);
  }
  if (!pid) throw new Error("failed to spawn mitmdump");

  try {
    await writeFile(PIDFILE, `${pid}\n${har}\n${port}\n`, "utf8");
  } catch (e) {
    // Never leave an untracked mitmdump behind if the pidfile cannot be written.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    throw e;
  }

  // `mitmdump --version` does not create the certstore in mitmproxy 12.x; the
  // CA only appears once the proxy starts. Give it a moment, then install it.
  await sleep(700);
  if (!pidRunning(pid)) {
    await rm(PIDFILE, { force: true });
    let tail = "";
    try {
      tail = (await readFile(logPath, "utf8")).trim().split("\n").slice(-5).join("\n");
    } catch {
      // No log; the generic message below is enough.
    }
    throw new Error(
      `mitmdump exited immediately (port ${port} already in use?): ${tail || "no output"}`
    );
  }

  let caInstalled: string | null = null;
  if (rooted) {
    const caReady = await waitForFile(MITM_CA_PATH, HAR_WAIT_MS);
    if (!caReady) warnings.push(`mitmproxy CA was not created at ${MITM_CA_PATH}`);
    else caInstalled = await installMitmCa(args.deviceId, warnings);
  }

  const proxied = await setDeviceProxy(
    args.deviceId,
    `${EMULATOR_HOST_ALIAS}:${port}`,
    30_000
  );
  if (proxied.code !== 0) {
    await stopCapture({ pid, har }, args.deviceId);
    throw new Error(
      `failed to set device HTTP proxy: ${proxied.detail || "no output"} — ` +
        `check 'adb devices' and that the device is rooted`
    );
  }

  // Auto-stop is in-process and unref'd: the MCP server keeps serving, and the
  // capture still ends by itself while the session is alive.
  const timer = setTimeout(() => {
    activeAutoStopTimer = null;
    activeAutoStopPid = null;
    void stopCapture({ pid, har, port }, args.deviceId).catch(() => {});
  }, durationSec * 1000);
  timer.unref();
  activeAutoStopTimer = timer;
  activeAutoStopPid = pid;

  const details = [
    `proxy set to ${EMULATOR_HOST_ALIAS}:${port} (emulator host alias; on a physical ` +
      `device use 'adb reverse tcp:${port} tcp:${port}' with http_proxy 127.0.0.1:${port})`,
    ...(caInstalled
      ? [`CA installed at ${caInstalled}`]
      : rooted
        ? ["CA not installed; on API 34+ the system CA store lives in the Conscrypt APEX, so system-trust install may fail — see docs/troubleshooting.md (APEX overlay/Magisk)"]
        : ["device not rooted; system CA not installed (a rootable google_apis image is required)"]),
    `auto-stop in ${durationSec}s — the HAR is flushed when mitmdump exits`,
    ...warnings.map((w) => `warning: ${w}`),
  ];

  return {
    content: [
      {
        type: "text" as const,
        text: [`capture started (pid ${pid}, har ${har})`, ...details].join("\n"),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Extra tools (build/test/device/logs/ui/emulator/static/profiling/multi/serve)
// ---------------------------------------------------------------------------

function adb(dev?: string): string[] { return dev ? ["-s", dev] : []; }

export async function handleGradleTest(a: z.infer<typeof ToolSchemas.gradleTest>) {
  const args = [":app:test", ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
export async function handleGradleLint(a: z.infer<typeof ToolSchemas.gradleLint>) {
  const args = [":app:lint", ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
export async function handleGradleDependencies(a: z.infer<typeof ToolSchemas.gradleDependencies>) {
  const r = await run("gradle", [`${a.configuration || "debugRuntimeClasspath"}:dependencies`.replace(/^/, ":"), "dependencies", "--configuration", a.configuration || "debugRuntimeClasspath"], { cwd: a.projectPath, timeout: 300_000 });
  // simpler: run dependencies task with configuration filter
  const r2 = await run("gradle", ["dependencies", "--configuration", a.configuration || "debugRuntimeClasspath"], { cwd: a.projectPath, timeout: 300_000 });
  return { content: [{ type: "text" as const, text: `exit=${r2.code}\n${(r2.stdout + "\n" + r2.stderr).slice(-12000)}` }], isError: r2.code !== 0 };
}
export async function handleBuildVariant(a: z.infer<typeof ToolSchemas.buildVariant>) {
  const args = [a.variant, ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
export async function handleBaselineProfileGenerate(a: z.infer<typeof ToolSchemas.baselineProfileGenerate>) {
  const args = [`${a.module}:connectedAndroidTest`, ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
// Device interaction
export async function handleAdbPush(a: z.infer<typeof ToolSchemas.adbPush>) {
  const r = await run("adb", [...adb(a.deviceId), "push", a.localPath, a.remotePath], { timeout: 300_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbPull(a: z.infer<typeof ToolSchemas.adbPull>) {
  const local = a.localPath ?? a.remotePath.split("/").pop() ?? "pulled";
  const r = await run("adb", [...adb(a.deviceId), "pull", a.remotePath, local], { timeout: 300_000 });
  return { content: [{ type: "text" as const, text: `saved to ${local}\n${r.stdout + r.stderr}` }], isError: r.code !== 0 };
}
export async function handleAdbRm(a: z.infer<typeof ToolSchemas.adbRm>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "rm", "-rf", a.remotePath], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbUninstall(a: z.infer<typeof ToolSchemas.adbUninstall>) {
  if (!validatePackageName(a.packageName)) return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "uninstall", a.packageName], { timeout: 120_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbClearData(a: z.infer<typeof ToolSchemas.adbClearData>) {
  if (!validatePackageName(a.packageName)) return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "pm", "clear", a.packageName], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbForceStop(a: z.infer<typeof ToolSchemas.adbForceStop>) {
  if (!validatePackageName(a.packageName)) return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "am", "force-stop", a.packageName], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbReboot(a: z.infer<typeof ToolSchemas.adbReboot>) {
  const r = await run("adb", [...adb(a.deviceId), "reboot"], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr || "rebooting" }] };
}
export async function handleAdbScreenrecord(a: z.infer<typeof ToolSchemas.adbScreenrecord>) {
  const dur = Math.max(1, a.durationSec ?? 10);
  const remote = "/sdcard/screenrecord.mp4";
  const local = a.outputPath ?? `screenrecord-${Date.now()}.mp4`;
  const r = await run("adb", [...adb(a.deviceId), "shell", "screenrecord", "--time-limit", String(dur), remote], { timeout: (dur + 5) * 1000 });
  if (r.code !== 0) return { content: [{ type: "text" as const, text: `screenrecord failed: ${r.stderr}` }], isError: true };
  const r2 = await run("adb", [...adb(a.deviceId), "pull", remote, local], { timeout: 120_000 });
  return { content: [{ type: "text" as const, text: `saved ${local}\n${r2.stdout + r2.stderr}` }], isError: r2.code !== 0 };
}
export async function handleAdbInput(a: z.infer<typeof ToolSchemas.adbInput>) {
  const base = adb(a.deviceId);
  let args: string[] = [];
  switch (a.action) {
    case "tap": args = [...base, "shell", "input", "tap", String(a.x ?? 0), String(a.y ?? 0)]; break;
    case "swipe": args = [...base, "shell", "input", "swipe", String(a.x ?? 0), String(a.y ?? 0), String(a.x2 ?? 0), String(a.y2 ?? 0)]; break;
    case "text": args = [...base, "shell", "input", "text", (a.text ?? "").replace(/ /g, "%s")]; break;
    case "keyevent": args = [...base, "shell", "input", "keyevent", a.keycode ?? "KEYCODE_ENTER"]; break;
  }
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbDeepLink(a: z.infer<typeof ToolSchemas.adbDeepLink>) {
  const args = [...adb(a.deviceId), "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", a.uri];
  if (a.packageName) args.push(a.packageName);
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbBroadcast(a: z.infer<typeof ToolSchemas.adbBroadcast>) {
  const args = [...adb(a.deviceId), "shell", "am", "broadcast", "-a", a.action, ...(a.extras ?? [])];
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbServiceStart(a: z.infer<typeof ToolSchemas.adbServiceStart>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "am", "startservice", "-n", a.component], { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbWifi(a: z.infer<typeof ToolSchemas.adbWifi>) {
  const base = adb(a.deviceId);
  let args: string[] = [];
  if (a.action === "tcpip") args = [...base, "tcpip", String(a.port ?? 5555)];
  else if (a.action === "connect") args = [...base, "connect", `${a.host ?? "127.0.0.1"}:${a.port ?? 5555}`];
  else args = [...base, "disconnect", `${a.host ?? "127.0.0.1"}:${a.port ?? 5555}`];
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbBattery(a: z.infer<typeof ToolSchemas.adbBattery>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "dumpsys", "battery"], { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
// Logs & diagnostics
export async function handleLogcatFiltered(a: z.infer<typeof ToolSchemas.logcatFiltered>) {
  const base = adb(a.deviceId);
  if (a.clear !== false) await run("adb", [...base, "logcat", "-c"], { timeout: 30_000 });
  await new Promise((res) => setTimeout(res, Math.max(0, (a.durationSec ?? 10) * 1000)));
  const args = [...base, "logcat", "-d", "-v", "time"];
  if (a.tag) args.push(a.tag);
  const r = await run("adb", args, { timeout: 120_000 });
  let lines = (r.stdout || "").split("\n");
  if (a.pattern) { try { const re = new RegExp(a.pattern, "m"); lines = lines.filter((l) => re.test(l)); } catch { return { content: [{ type: "text" as const, text: `Invalid pattern regex` }], isError: true }; } }
  if (a.packageName) lines = lines.filter((l) => l.includes(a.packageName!));
  const total = (r.stdout || "").split("\n").filter((l) => l.trim()).length;
  const text = [`total=${total} matched=${lines.length} shown=${Math.min(lines.length, 500)}`, ...lines.slice(0, 500)].join("\n");
  return { content: [{ type: "text" as const, text }], isError: r.code !== 0 };
}
export async function handleAnrCheck(a: z.infer<typeof ToolSchemas.anrCheck>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "cat", "/data/anr/traces.txt"], { timeout: 30_000 });
  const text = r.stdout || r.stderr;
  const anr = /ANR in|Application Not Responding/i.test(text);
  return { content: [{ type: "text" as const, text: `anr_detected=${anr}\n${text.slice(0, 8000)}` }], isError: r.code !== 0 };
}
export async function handleCrashSummary(a: z.infer<typeof ToolSchemas.crashSummary>) {
  const base = adb(a.deviceId);
  await run("adb", [...base, "logcat", "-c"], { timeout: 30_000 });
  await new Promise((res) => setTimeout(res, Math.max(0, (a.durationSec ?? 10) * 1000)));
  const r = await run("adb", [...base, "logcat", "-d"], { timeout: 120_000 });
  const crashes = (r.stdout || "").split("\n").filter((l) => /FATAL EXCEPTION|AndroidRuntime/i.test(l));
  return { content: [{ type: "text" as const, text: `crashes=${crashes.length}\n${crashes.slice(0, 50).join("\n")}` }], isError: false };
}
// UI inspection
export async function handleUiDump(a: z.infer<typeof ToolSchemas.uiDump>) {
  const remote = "/sdcard/window_dump.xml";
  const local = a.outputPath ?? `/tmp/ui-dump-${Date.now()}.xml`;
  const base = adb(a.deviceId);
  let r = await run("adb", [...base, "shell", "uiautomator", "dump", remote], { timeout: 60_000 });
  if (r.code !== 0) return { content: [{ type: "text" as const, text: `uiautomator dump failed: ${r.stderr}` }], isError: true };
  r = await run("adb", [...base, "pull", remote, local], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: `saved ${local}\n${r.stdout + r.stderr}` }], isError: r.code !== 0 };
}
export async function handleComposeRecomposition(a: z.infer<typeof ToolSchemas.composeRecomposition>) {
  const base = adb(a.deviceId);
  const r = await run("adb", [...base, "shell", "dumpsys", "activity", a.packageName ? a.packageName : ""].filter(Boolean), { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(0, 8000)}` }], isError: r.code !== 0 };
}
export async function handleLayoutBounds(a: z.infer<typeof ToolSchemas.layoutBounds>) {
  const base = adb(a.deviceId);
  const val = a.enabled ? "true" : "false";
  const r = await run("adb", [...base, "shell", "setprop", "debug.layout", val], { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: `debug.layout=${val}\n${r.stdout + r.stderr}` }], isError: r.code !== 0 };
}
// Emulator management
export async function handleAvdCreate(a: z.infer<typeof ToolSchemas.avdCreate>) {
  const r = await run("avdmanager", ["create", "avd", "-n", a.avdName, "-k", a.systemImage, "-d", a.device], { timeout: 120_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAvdDelete(a: z.infer<typeof ToolSchemas.avdDelete>) {
  const r = await run("avdmanager", ["delete", "avd", "-n", a.avdName], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAvdWipe(a: z.infer<typeof ToolSchemas.avdWipe>) {
  const r = await run("emulator", ["-avd", a.avdName, "-wipe-data", "-no-window"], { timeout: 120_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleEmulatorSnapshot(a: z.infer<typeof ToolSchemas.emulatorSnapshot>) {
  const base = adb(a.deviceId);
  if (a.action === "list") {
    const r = await run("adb", [...base, "emu", "avd", "snapshot", "list"], { timeout: 30_000 });
    return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
  }
  const name = a.name ?? "default";
  const cmd = a.action === "save" ? ["emu", "avd", "snapshot", "save", name] : ["emu", "avd", "snapshot", "load", name];
  const r = await run("adb", [...base, ...cmd], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
// Static analysis
async function unzipList(apkPath: string): Promise<string> {
  const r = await run("unzip", ["-l", apkPath], { timeout: 120_000 });
  return r.stdout + r.stderr;
}
export async function handleApkInfo(a: z.infer<typeof ToolSchemas.apkInfo>) {
  const r = await run("aapt2", ["dump", "badging", a.apkPath], { timeout: 120_000 });
  if (r.code !== 0) {
    // fallback to unzip listing
    const u = await unzipList(a.apkPath);
    return { content: [{ type: "text" as const, text: `aapt2 unavailable/failed; zip listing:\n${u.slice(0, 12000)}` }], isError: true };
  }
  return { content: [{ type: "text" as const, text: r.stdout.slice(0, 12000) }], isError: false };
}
export async function handleApkDecompile(a: z.infer<typeof ToolSchemas.apkDecompile>) {
  const out = a.outputDir ?? `/tmp/decompiled-${Date.now()}`;
  const tool = a.tool === "apktool" ? "apktool" : "jadx";
  const args = tool === "apktool" ? ["d", a.apkPath, "-o", out, "-f"] : ["-d", a.apkPath, "-o", out];
  const r = await run(tool, args, { timeout: 600_000 });
  return { content: [{ type: "text" as const, text: `tool=${tool} out=${out}\nexit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-8000)}` }], isError: r.code !== 0 };
}
export async function handleManifestInspect(a: z.infer<typeof ToolSchemas.manifestInspect>) {
  const r = await run("aapt2", ["dump", "xmltree", a.apkPath, "AndroidManifest.xml"], { timeout: 120_000 });
  if (r.code !== 0) return { content: [{ type: "text" as const, text: `aapt2 failed: ${r.stderr}` }], isError: true };
  return { content: [{ type: "text" as const, text: r.stdout.slice(0, 20000) }], isError: false };
}
export async function handleNativeLibs(a: z.infer<typeof ToolSchemas.nativeLibs>) {
  const listing = await unzipList(a.apkPath);
  const libs = listing.split("\n").filter((l) => /\.so\b/.test(l));
  return { content: [{ type: "text" as const, text: `native libs (${libs.length}):\n${libs.join("\n").slice(0, 12000)}` }] };
}
export async function handleDexStrings(a: z.infer<typeof ToolSchemas.dexStrings>) {
  const r = await run("strings", [a.apkPath], { timeout: 120_000 });
  let lines = (r.stdout || "").split("\n");
  if (a.pattern) { try { const re = new RegExp(a.pattern); lines = lines.filter((l) => re.test(l)); } catch { return { content: [{ type: "text" as const, text: "Invalid pattern" }], isError: true }; } }
  return { content: [{ type: "text" as const, text: lines.slice(0, 500).join("\n") }], isError: r.code !== 0 };
}
// Testing
export async function handleInstrumentedTest(a: z.infer<typeof ToolSchemas.instrumentedTest>) {
  const args = [`${a.module}:connectedAndroidTest`, ...(a.testFilter ? [`-Pandroid.testInstrumentationRunnerArguments.class=${a.testFilter}`] : []), ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
export async function handleTestCoverage(a: z.infer<typeof ToolSchemas.testCoverage>) {
  const r = await run("gradle", [`${a.module}:testDebugUnitTestCoverage`], { cwd: a.projectPath, timeout: 600_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
export async function handleMacrobenchmark(a: z.infer<typeof ToolSchemas.macrobenchmark>) {
  const args = [`${a.module}:connectedAndroidTest`, ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return { content: [{ type: "text" as const, text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}` }], isError: r.code !== 0 };
}
// Profiling
export async function handlePerfettoTrace(a: z.infer<typeof ToolSchemas.perfettoTrace>) {
  const dur = Math.max(1, a.durationSec ?? 10);
  const out = a.outputPath ?? `/tmp/trace-${Date.now()}.perfetto-trace`;
  const base = adb(a.deviceId);
  const r = await run("adb", [...base, "shell", "perfetto", "-o", "/data/misc/perfetto-traces/trace.perfetto-trace", "-t", `${dur}s`, "sched freq idle am wm gfx view binder_driver hal dalvik camera input res memory"], { timeout: (dur + 10) * 1000 });
  if (r.code !== 0) return { content: [{ type: "text" as const, text: `perfetto failed: ${r.stderr}` }], isError: true };
  const r2 = await run("adb", [...base, "pull", "/data/misc/perfetto-traces/trace.perfetto-trace", out], { timeout: 120_000 });
  return { content: [{ type: "text" as const, text: `saved ${out}\n${r2.stdout + r2.stderr}` }], isError: r2.code !== 0 };
}
export async function handleMemoryProfile(a: z.infer<typeof ToolSchemas.memoryProfile>) {
  if (!validatePackageName(a.packageName)) return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "dumpsys", "meminfo", a.packageName], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(0, 12000) }], isError: r.code !== 0 };
}
export async function handleStartupTime(a: z.infer<typeof ToolSchemas.startupTime>) {
  if (!validatePackageName(a.packageName)) return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const iters = Math.max(1, a.iterations ?? 5);
  const lines: string[] = [];
  for (let i = 0; i < iters; i++) {
    const r = await run("adb", [...adb(a.deviceId), "shell", "am", "start-activity", "-W", "-n", `${a.packageName}/.MainActivity`], { timeout: 60_000 });
    lines.push(r.stdout.split("\n").find((l) => /TotalTime/i.test(l)) ?? r.stdout.slice(0, 200));
    await run("adb", [...adb(a.deviceId), "shell", "am", "force-stop", a.packageName], { timeout: 30_000 });
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}
// Multi-device
export async function handleAdbParallel(a: z.infer<typeof ToolSchemas.adbParallel>) {
  const devices = a.deviceIds && a.deviceIds.length ? a.deviceIds : (await (async () => { const r = await run("adb", ["devices"]); return r.stdout.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean); })());
  const results = await Promise.all(devices.map(async (d) => {
    const r = await run("adb", ["-s", d, "shell", a.command], { timeout: 60_000 });
    return `=== ${d} (exit ${r.code}) ===\n${(r.stdout + r.stderr).slice(0, 4000)}`;
  }));
  return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
}
// APK serving (local network, python http.server in the APK output dir)
const SERVE_STATE_FILE = "/tmp/android-mcp-serve.json";
export async function handleApkServe(a: z.infer<typeof ToolSchemas.apkServe>) {
  if (a.action === "stop") {
    try {
      const fsMod = await import("node:fs"); const st = JSON.parse(fsMod.readFileSync(SERVE_STATE_FILE, "utf8"));
      if (st.pid && (await (async () => { try { process.kill(st.pid, 0); return true; } catch { return false; } })())) {
        process.kill(st.pid, "SIGTERM");
      }
    } catch { /* no state */ }
    try { const fsMod = await import("node:fs"); fsMod.unlinkSync(SERVE_STATE_FILE); } catch { /* ignore */ }
    return { content: [{ type: "text" as const, text: "apk serve stopped" }] };
  }
  const port = a.port ?? 8000;
  const dir = a.dir ?? "/tmp";
  const { spawn } = await import("node:child_process");
  const child = spawn("python3", ["-m", "http.server", String(port), "--directory", dir, "--bind", "0.0.0.0"], { detached: true, stdio: "ignore" });
  child.unref();
  const fs = await import("node:fs");
  fs.writeFileSync(SERVE_STATE_FILE, JSON.stringify({ pid: child.pid, port, dir }));
  // try to find an apk to report
  let apk = "";
  try {
    const { execSync } = await import("node:child_process");
    apk = execSync(`find "${dir}" -name "*.apk" 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
  } catch { /* ignore */ }
  const ip = "0.0.0.0";
  return { content: [{ type: "text" as const, text: `serving ${dir} on http://${ip}:${port}/\n${apk ? "apk: " + apk : "no .apk found in dir"}\nstop with apk_serve action=stop` }] };
}
