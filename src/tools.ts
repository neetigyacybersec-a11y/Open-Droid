import { z } from "zod";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
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
import { ensureServer, resolveFridaCli } from "./frida.js";

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
    timeoutSec: z.number().optional().default(60),
  }),
  adbLogcat: z.object({
    deviceId: z.string().optional(),
    tag: z.string().optional().describe("Filter: adb logcat tag selector, e.g. MyActivity:E or *:W"),
    pattern: z.string().optional().describe("Regex applied to captured log text"),
    durationSec: z.number().optional().default(10).describe("Seconds to wait before dumping (logcat -c then -d)"),
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
    durationSec: z.number().optional().default(30),
  }),
  fridaTraceMethods: z.object({
    packageName: z.string(),
    className: z.string().describe("Exact class or regex-resolvable FQN, e.g. com.example.app.Crypto"),
    methodRegex: z.string().optional().default(".*"),
    deviceId: z.string().optional(),
    durationSec: z.number().optional().default(30),
  }),
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
  const out = `exit=${r.code}\n--- stdout ---\n${capOutput(r.stdout)}\n--- stderr ---\n${r.stderr}`;
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
  const out = `${head}${note}\nexit=${r.code}\n--- stdout ---\n${capOutput(r.stdout)}\n--- stderr ---\n${r.stderr}`;
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
  const spawn = o.spawn !== false;
  const durationSec = o.durationSec ?? 30;
  const target = [
    ...fridaDeviceArgs(o.deviceId),
    ...(spawn ? ["-f", o.packageName] : [o.packageName]),
  ];
  const dir = await tmpDir("android-mcp-frida-");
  const scriptFile = join(dir, "hook.js");
  await writeFile(scriptFile, o.source, "utf8");
  const timeoutMs = Math.max(1, durationSec) * 1000 + 15_000;
  const started = Date.now();
  try {
    const r = await run(cli, [...target, "-l", scriptFile], { timeout: timeoutMs });
    const budgetKill = r.code !== 0 && Date.now() - started >= timeoutMs - 1_000;
    const header = [
      `cmd=frida ${[...target, "-l", "<tmp>/hook.js"].join(" ")}`,
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
