import { z } from "zod";
import { constants, readFileSync, unlinkSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";

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
  shquote,
  validateRemotePath,
  notOptionLike,
  validateIntentAction,
  validateComponent,
  serveStatePath,
} from "./util.js";
import { ensureServer, resolveFridaCli } from "./frida.js";
import { renderPrivacyReport, scanPrivacyProject } from "./privacy.js";
import { auditProjectManifest } from "./manifestAudit.js";
import { scanProjectSecrets } from "./secretScan.js";
import { renderPolicyPreflight, runPolicyPreflight } from "./policyPreflight.js";

export { handleNetCapture, recoverCaptureSession } from "./netCapture.js";

export const ToolSchemas = {
  envCheck: z.object({}),
  gradle: z.object({
    projectPath: z.string().describe("Absolute path to the Gradle project root"),
    task: z.string().describe("Gradle task, e.g. :app:assembleDebug"),
    args: z.array(z.string()).optional().describe("Extra gradle args"),
    offline: z
      .boolean()
      .optional()
      .default(false)
      .describe("Run with --offline (vendored toolchain)"),
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
    scale: z
      .number()
      .min(0.1)
      .max(3)
      .optional()
      .describe("Emulator window scale (0.1-3.0) passed as -scale; use it on small/high-DPI hosts"),
    windowSize: z
      .string()
      .regex(/^\d{3,5}x\d{3,5}$/, "expected WIDTHxHEIGHT, e.g. 900x600")
      .refine((value) => {
        const [w, h] = value.split("x").map(Number);
        return w >= 200 && w <= 10000 && h >= 200 && h <= 10000;
      }, "windowSize must be between 200x200 and 10000x10000")
      .optional()
      .describe("Override the window/display geometry as WIDTHxHEIGHT (passed as -skin)"),
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(1800)
      .optional()
      .default(180)
      .describe("Upper bound for the new instance to reach sys.boot_completed=1"),
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
    tag: z
      .string()
      .optional()
      .describe("Filter: adb logcat tag selector, e.g. MyActivity:E or *:W"),
    pattern: z.string().optional().describe("Regex applied to captured log text"),
    durationSec: z
      .number()
      .max(86400)
      .optional()
      .default(10)
      .describe("Seconds to wait before dumping (logcat -c then -d)"),
    clear: z
      .boolean()
      .optional()
      .default(true)
      .describe("Clear the device log buffer before waiting"),
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
    spawn: z
      .boolean()
      .optional()
      .default(true)
      .describe("true: spawn+resume via -f; false: attach to running process by name"),
    durationSec: z.number().max(86400).optional().default(30),
  }),
  fridaTraceMethods: z.object({
    packageName: z.string(),
    className: z
      .string()
      .describe("Exact class or regex-resolvable FQN, e.g. com.example.app.Crypto"),
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
  gradleTest: z.object({
    projectPath: z.string(),
    args: z.array(z.string()).optional(),
    offline: z.boolean().optional().default(false),
  }),
  gradleLint: z.object({
    projectPath: z.string(),
    args: z.array(z.string()).optional(),
    offline: z.boolean().optional().default(false),
  }),
  gradleDependencies: z.object({
    projectPath: z.string(),
    configuration: z.string().optional().default("debugRuntimeClasspath"),
  }),
  buildVariant: z.object({
    projectPath: z.string(),
    variant: z
      .string()
      .describe("Variant label such as debug, release, or stagingDebug (not a Gradle task name)"),
    module: z.string().optional().default(":app").describe("Gradle module path, e.g. :app or :lib"),
    args: z.array(z.string()).optional(),
    offline: z.boolean().optional().default(false),
  }),
  baselineProfileGenerate: z.object({
    projectPath: z.string(),
    module: z.string().optional().default(":app"),
    args: z.array(z.string()).optional(),
  }),
  adbPush: z.object({
    deviceId: z.string().optional(),
    localPath: z.string(),
    remotePath: z.string(),
  }),
  adbPull: z.object({
    deviceId: z.string().optional(),
    remotePath: z.string(),
    localPath: z.string().optional(),
  }),
  adbRm: z.object({ deviceId: z.string().optional(), remotePath: z.string() }),
  adbUninstall: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbClearData: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbForceStop: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  adbReboot: z.object({ deviceId: z.string().optional() }),
  adbScreenrecord: z.object({
    deviceId: z.string().optional(),
    durationSec: z.number().optional().default(10),
    outputPath: z.string().optional(),
  }),
  adbInput: z.object({
    deviceId: z.string().optional(),
    action: z.enum(["tap", "swipe", "text", "keyevent"]),
    x: z.number().optional(),
    y: z.number().optional(),
    x2: z.number().optional(),
    y2: z.number().optional(),
    text: z.string().optional(),
    keycode: z.string().optional(),
  }),
  adbDeepLink: z.object({
    deviceId: z.string().optional(),
    uri: z.string(),
    packageName: z.string().optional(),
  }),
  adbBroadcast: z.object({
    deviceId: z.string().optional(),
    action: z.string(),
    extras: z.array(z.string()).optional(),
  }),
  adbServiceStart: z.object({ deviceId: z.string().optional(), component: z.string() }),
  adbWifi: z.object({
    deviceId: z.string().optional(),
    action: z.enum(["tcpip", "connect", "disconnect"]),
    port: z.number().optional().default(5555),
    host: z.string().optional(),
  }),
  adbBattery: z.object({ deviceId: z.string().optional() }),
  logcatFiltered: z.object({
    deviceId: z.string().optional(),
    tag: z.string().optional(),
    packageName: z.string().optional(),
    pattern: z.string().optional(),
    durationSec: z.number().optional().default(10),
    clear: z.boolean().optional().default(true),
  }),
  anrCheck: z.object({ deviceId: z.string().optional() }),
  crashSummary: z.object({
    deviceId: z.string().optional(),
    durationSec: z.number().optional().default(10),
  }),
  uiDump: z.object({ deviceId: z.string().optional(), outputPath: z.string().optional() }),
  composeRecomposition: z.object({
    deviceId: z.string().optional(),
    packageName: z.string().optional(),
  }),
  layoutBounds: z.object({ deviceId: z.string().optional(), enabled: z.boolean().default(true) }),
  avdCreate: z.object({
    avdName: z.string(),
    systemImage: z.string(),
    device: z.string().optional().default("pixel_6"),
  }),
  avdDelete: z.object({ avdName: z.string() }),
  avdWipe: z.object({
    avdName: z.string(),
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(1800)
      .optional()
      .default(300)
      .describe("Upper bound for reaching boot completion and stopping the wipe instance"),
  }),
  emulatorSnapshot: z.object({
    deviceId: z.string().optional(),
    action: z.enum(["save", "load", "list"]),
    name: z.string().optional(),
  }),
  apkInfo: z.object({ apkPath: z.string() }),
  apkDecompile: z.object({
    apkPath: z.string(),
    outputDir: z.string().optional(),
    overwrite: z.boolean().optional().default(false),
    tool: z.enum(["jadx", "apktool"]).optional().default("jadx"),
  }),
  manifestInspect: z.object({ apkPath: z.string() }),
  privacyScan: z.object({
    projectPath: z.string().describe("Absolute path to the Android project root"),
    declarationsPath: z
      .string()
      .optional()
      .describe("Path to privacy/data-safety.json; defaults to <project>/privacy/data-safety.json"),
    reportPath: z.string().optional().describe("Write the Markdown inventory to this file"),
    strict: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return an error when blockers are present"),
  }),
  secretScan: z.object({
    projectPath: z.string().describe("Absolute path to the Android project root"),
    severityThreshold: z
      .enum(["critical", "high", "medium", "low"])
      .optional()
      .default("low")
      .describe("Only report findings at or above this severity"),
    reportPath: z.string().optional().describe("Write the Markdown report to this file"),
  }),
  securityAudit: z.object({
    projectPath: z.string().describe("Absolute path to the Android project root"),
    reportPath: z.string().optional().describe("Write the Markdown report to this file"),
  }),
  policyPreflight: z.object({
    projectPath: z.string().describe("Absolute path to the Android project root"),
    strict: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return an error when any engineering check fails"),
    reportPath: z.string().optional().describe("Write the Markdown report to this file"),
  }),
  nativeLibs: z.object({ apkPath: z.string() }),
  dexStrings: z.object({ apkPath: z.string(), pattern: z.string().optional() }),
  instrumentedTest: z.object({
    projectPath: z.string(),
    module: z.string().optional().default(":app"),
    testFilter: z.string().optional(),
    device: z.string().optional(),
    offline: z.boolean().optional().default(false),
    args: z.array(z.string()).optional(),
  }),
  testCoverage: z.object({
    projectPath: z.string(),
    module: z.string().optional().default(":app"),
  }),
  macrobenchmark: z.object({
    projectPath: z.string(),
    module: z.string().optional().default(":macrobenchmark"),
    args: z.array(z.string()).optional(),
  }),
  perfettoTrace: z.object({
    deviceId: z.string().optional(),
    durationSec: z.number().optional().default(10),
    outputPath: z.string().optional(),
  }),
  memoryProfile: z.object({ deviceId: z.string().optional(), packageName: z.string() }),
  startupTime: z.object({
    deviceId: z.string().optional(),
    packageName: z.string(),
    activity: z
      .string()
      .optional()
      .describe("Optional activity class (.SettingsActivity) or full package/activity component"),
    iterations: z.number().optional().default(5),
  }),
  adbParallel: z.object({ command: z.string(), deviceIds: z.array(z.string()).optional() }),
  apkServe: z.object({
    action: z.enum(["start", "stop"]),
    port: z.number().int().min(1).max(65535).optional().default(8000),
    dir: z.string().optional(),
    expose: z.boolean().optional().default(false),
    readyTimeoutSec: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .default(10)
      .describe("Upper bound for the server to answer a loopback HTTP request"),
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
    return {
      content: [{ type: "text" as const, text: "Invalid gradle task name." }],
      isError: true,
    };
  }
  const gradleArgs = [args.task, ...(args.offline ? ["--offline"] : []), ...(args.args ?? [])];
  const r = await run("gradle", gradleArgs, { cwd: args.projectPath, timeout: 600_000 });
  const out = `exit=${r.code}\n--- stdout ---\n${r.stdout.slice(-8000)}\n--- stderr ---\n${r.stderr.slice(-4000)}`;
  return { content: [{ type: "text" as const, text: out }], isError: r.code !== 0 };
}

export async function handleAdbDevices() {
  const r = await run("adb", ["devices", "-l"]);
  return {
    content: [{ type: "text" as const, text: r.stdout || r.stderr }],
    isError: r.code !== 0,
  };
}

export async function handleAdbScreenshot(args: z.infer<typeof ToolSchemas.adbScreenshot>) {
  const base = await adbBase(args.deviceId);
  const persistent = Boolean(args.outputPath);
  const dir = persistent ? null : await tmpDir();
  const local = args.outputPath ?? join(dir!, "screen.png");
  // Unique per capture: overlapping captures must not overwrite each other's
  // device-side file before the pull completes (issue 84).
  const remote = `/sdcard/screen-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.png`;
  try {
    let r = await run("adb", [...base, "shell", "screencap", "-p", remote], {
      timeout: 60_000,
    });
    if (r.code !== 0) {
      return {
        content: [{ type: "text" as const, text: `screencap failed: ${r.stderr}` }],
        isError: true,
      };
    }
    r = await run("adb", [...base, "pull", remote, local], { timeout: 120_000 });
    if (r.code !== 0) {
      return {
        content: [{ type: "text" as const, text: `pull failed: ${r.stderr}` }],
        isError: true,
      };
    }
    const b64 = await readBase64(local);
    if (persistent) {
      return {
        content: [
          { type: "image" as const, data: b64, mimeType: "image/png" },
          { type: "text" as const, text: `Saved screenshot to ${local}` },
        ],
        isError: false,
      };
    }
    return {
      content: [
        { type: "image" as const, data: b64, mimeType: "image/png" },
        {
          type: "text" as const,
          text: "Screenshot captured inline (transient; no local file retained). Pass outputPath to keep a copy.",
        },
      ],
      isError: false,
    };
  } finally {
    // Best-effort remote cleanup; never mask the primary diagnostic.
    await run("adb", [...base, "shell", "rm", "-f", remote], { timeout: 15_000 }).catch(
      () => undefined,
    );
    if (dir) await cleanup(dir);
  }
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
  const r = await run("adb", [
    ...base,
    "shell",
    "monkey",
    "-p",
    args.packageName,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
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
  return {
    content: [{ type: "text" as const, text: r.stdout || r.stderr }],
    isError: r.code !== 0,
  };
}

// Issue 81: a returned ChildProcess object is not proof that an emulator
// started or booted. Verify a new ADB serial belongs to the requested AVD, wait
// for sys.boot_completed=1, and report readiness only after both checks.
export async function handleEmulatorBoot(args: z.infer<typeof ToolSchemas.emulatorBoot>) {
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  if (!notOptionLike(args.avdName) || !AVD_NAME_RE.test(args.avdName))
    return fail(`Invalid avd name: ${args.avdName}`);

  const listed = await run("emulator", ["-list-avds"], { timeout: 30_000 });
  if (listed.code !== 0)
    return fail(
      `status=unavailable\navd=${args.avdName}\nreason=emulator -list-avds failed (exit ${listed.code}): ${listed.stderr.trim()}`,
    );
  const avds = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!avds.includes(args.avdName))
    return fail(`status=not-found\navd=${args.avdName}\navailable=${avds.join(",") || "(none)"}`);

  const before = await runningEmulatorSerials();
  if (before === null)
    return fail(
      `status=unavailable\navd=${args.avdName}\nreason=adb devices failed; cannot establish a baseline`,
    );
  for (const serial of before) {
    if ((await emulatorAvdName(serial)) === args.avdName)
      return fail(
        `status=already-running\navd=${args.avdName}\nserial=${serial}\n` +
          `The AVD is already running; use the existing instance instead of starting a duplicate.`,
      );
  }

  const timeoutSec = Math.max(1, args.timeoutSec ?? 180);
  const deadline = Date.now() + timeoutSec * 1000;
  const { spawn: sp } = await import("node:child_process");
  const gpu = args.gpu ?? "swiftshader_indirect";
  const launchArgs = [
    "-avd",
    args.avdName,
    ...(args.headless ? ["-no-window", "-no-audio"] : []),
    "-gpu",
    gpu,
    ...(args.scale !== undefined ? ["-scale", String(args.scale)] : []),
    ...(args.windowSize ? ["-skin", args.windowSize] : []),
  ];
  const child = sp("emulator", launchArgs, { detached: true, stdio: "ignore" });
  let spawnError: Error | null = null;
  let exited = false;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  const exitedNow = () => exited || child.exitCode !== null || child.signalCode !== null;

  let serial: string | null = null;
  while (!serial && Date.now() < deadline) {
    if (spawnError || exitedNow()) break;
    const now = await runningEmulatorSerials();
    for (const candidate of (now ?? []).filter((s) => !before.includes(s))) {
      if ((await emulatorAvdName(candidate)) === args.avdName) {
        serial = candidate;
        break;
      }
    }
    if (!serial) await sleep(WIPE_POLL_MS);
  }
  if (!serial) {
    const exitedEarly = exitedNow();
    const instance = await stopManagedChild(child);
    const reason = spawnError
      ? `could not start emulator: ${(spawnError as Error).message}`
      : exitedEarly
        ? "emulator exited before it appeared on ADB"
        : "the new instance did not appear on ADB before the deadline";
    return fail(
      `status=${spawnError || exitedEarly ? "exited" : "timeout"}\navd=${args.avdName}\nphase=serial\n` +
        `instance=${instance}\nreason=${reason}`,
    );
  }

  let booted = false;
  while (!booted && Date.now() < deadline) {
    if (exitedNow()) break;
    const r = await run("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
      timeout: 15_000,
    });
    if (r.code === 0 && r.stdout.trim() === "1") booted = true;
    else await sleep(WIPE_POLL_MS);
  }
  if (!booted) {
    const exitedEarly = exitedNow();
    await run("adb", ["-s", serial, "emu", "kill"], { timeout: 30_000 }).catch(() => undefined);
    const instance = await stopManagedChild(child);
    return fail(
      `status=${exitedEarly ? "exited" : "timeout"}\navd=${args.avdName}\nserial=${serial}\nphase=boot\n` +
        `instance=${instance}\nreason=sys.boot_completed=1 was not observed before the deadline`,
    );
  }
  if (exitedNow())
    return fail(
      `status=exited\navd=${args.avdName}\nserial=${serial}\nreason=emulator exited immediately after boot readiness`,
    );

  return {
    content: [
      {
        type: "text" as const,
        text:
          `status=ready\navd=${args.avdName}\nserial=${serial}\nboot=sys.boot_completed=1\n` +
          `pid=${child.pid}\nThe instance is running; stop it with adb -s ${serial} emu kill.`,
      },
    ],
    isError: false,
  };
}

export async function handleMaestroRun(args: z.infer<typeof ToolSchemas.maestroRun>) {
  const base = args.deviceId ? ["--device", args.deviceId] : [];
  const r = await run("maestro", ["test", ...base, args.flowPath], { timeout: 600_000 });
  return {
    content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(-12000) }],
    isError: r.code !== 0,
  };
}

export async function handleComposePreviewRender(
  args: z.infer<typeof ToolSchemas.composePreviewRender>,
) {
  const cli = await which("compose-preview");
  if (!cli) {
    return {
      content: [
        {
          type: "text" as const,
          text: "compose-preview CLI not found. Install compose-ai-tools first (see report).",
        },
      ],
      isError: true,
    };
  }
  const argsArr = ["render", "--project", args.projectPath];
  if (args.previewFqn) argsArr.push("--preview", args.previewFqn);
  const r = await run(cli, argsArr, { cwd: args.projectPath, timeout: 600_000 });
  return {
    content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(-12000) }],
    isError: r.code !== 0,
  };
}

export async function handleSkillsList() {
  const cli = await which("android");
  if (cli) {
    const r = await run(cli, ["skills", "list"]);
    if (r.code === 0) return { content: [{ type: "text" as const, text: r.stdout }] };
  }
  // fallback: try npx android-skills-mcp? just report
  return {
    content: [
      {
        type: "text" as const,
        text: "Android CLI not found. Install via https://developer.android.com/tools/agents/android-cli/download, or use android-skills-mcp MCP server directly.",
      },
    ],
  };
}

export async function handleSkillsSearch(args: z.infer<typeof ToolSchemas.skillsSearch>) {
  const cli = await which("android");
  if (cli) {
    const r = await run(cli, ["skills", "search", args.query]);
    if (r.code === 0) return { content: [{ type: "text" as const, text: r.stdout }] };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `Android CLI not found; cannot search skills for "${args.query}".`,
      },
    ],
  };
}

export async function handleSdkmanagerInstall(args: z.infer<typeof ToolSchemas.sdkmanagerInstall>) {
  const cli = await which("sdkmanager");
  if (!cli) {
    return {
      content: [
        {
          type: "text" as const,
          text: "sdkmanager not found. Set ANDROID_HOME and install command-line tools.",
        },
      ],
      isError: true,
    };
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
  return text.length > max
    ? `${text.slice(0, max)}\n[truncated: ${text.length} chars total]`
    : text;
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

  const r = await run(
    "adb",
    [...base, "logcat", "-d", "-v", "time", ...(args.tag ? [args.tag] : [])],
    {
      timeout: 120_000,
    },
  );
  if (r.code !== 0) {
    const err = [`logcat -d failed (exit=${r.code})`, r.stderr.trim(), ...notes]
      .filter(Boolean)
      .join("\n");
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
        content: [
          { type: "text" as const, text: `Invalid pattern regex: ${e?.message ?? String(e)}` },
        ],
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

// net_capture lives in src/netCapture.ts; the handler is re-exported below.

// ---------------------------------------------------------------------------
// Extra tools (build/test/device/logs/ui/emulator/static/profiling/multi/serve)
// ---------------------------------------------------------------------------

function adb(dev?: string): string[] {
  return dev ? ["-s", dev] : [];
}

export async function handleGradleTest(a: z.infer<typeof ToolSchemas.gradleTest>) {
  const args = [":app:test", ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleGradleLint(a: z.infer<typeof ToolSchemas.gradleLint>) {
  const args = [":app:lint", ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleGradleDependencies(a: z.infer<typeof ToolSchemas.gradleDependencies>) {
  const r2 = await run(
    "gradle",
    ["dependencies", "--configuration", a.configuration || "debugRuntimeClasspath"],
    { cwd: a.projectPath, timeout: 300_000 },
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r2.code}\n${(r2.stdout + "\n" + r2.stderr).slice(-12000)}`,
      },
    ],
    isError: r2.code !== 0,
  };
}
export async function handleBuildVariant(a: z.infer<typeof ToolSchemas.buildVariant>) {
  const module = a.module ?? ":app";
  if (!/^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(module)) {
    return {
      content: [{ type: "text" as const, text: `Invalid Gradle module path: ${module}` }],
      isError: true,
    };
  }
  const label = a.variant.trim().replace(/^assemble/, "");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(label)) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Invalid variant label: ${a.variant}. Pass a variant name such as debug or stagingDebug, not a Gradle task or option.`,
        },
      ],
      isError: true,
    };
  }
  const suffix = label.charAt(0).toUpperCase() + label.slice(1);

  // Discover assemble tasks so an unknown flavor fails before a build is
  // attempted. Discovery is best-effort: a project whose task listing fails
  // still gets the deterministic mapping and Gradle's own task error.
  const discovery = await run("gradle", [`${module}:tasks`, "--all", "-q"], {
    cwd: a.projectPath,
    timeout: 180_000,
  });
  const available = [
    ...new Set([...discovery.stdout.matchAll(/\bassemble([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1])),
  ];
  let resolvedSuffix = suffix;
  if (discovery.code === 0 && available.length > 0) {
    const match = available.find((name) => name.toLowerCase() === suffix.toLowerCase());
    if (!match) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Unknown variant "${a.variant}" for module ${module}. ` +
              `Available assemble tasks: ${available.map((n) => `assemble${n}`).join(", ")}`,
          },
        ],
        isError: true,
      };
    }
    resolvedSuffix = match;
  }
  const task = `${module}:assemble${resolvedSuffix}`;
  if (!validateGradleTask(task)) {
    return {
      content: [{ type: "text" as const, text: `Invalid resolved Gradle task: ${task}` }],
      isError: true,
    };
  }
  const args = [task, ...(a.offline ? ["--offline"] : []), ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 600_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `task=${task}\nexit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleBaselineProfileGenerate(
  a: z.infer<typeof ToolSchemas.baselineProfileGenerate>,
) {
  const args = [`${a.module}:connectedAndroidTest`, ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
// Device interaction
export async function handleAdbPush(a: z.infer<typeof ToolSchemas.adbPush>) {
  const r = await run("adb", [...adb(a.deviceId), "push", a.localPath, a.remotePath], {
    timeout: 300_000,
  });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbPull(a: z.infer<typeof ToolSchemas.adbPull>) {
  const local = a.localPath ?? a.remotePath.split("/").pop() ?? "pulled";
  const r = await run("adb", [...adb(a.deviceId), "pull", a.remotePath, local], {
    timeout: 300_000,
  });
  return {
    content: [{ type: "text" as const, text: `saved to ${local}\n${r.stdout + r.stderr}` }],
    isError: r.code !== 0,
  };
}
export async function handleAdbRm(a: z.infer<typeof ToolSchemas.adbRm>) {
  // Issue 67: the device shell re-parses everything after "shell", so the
  // path must be metachar-free, in a test-relevant scope, and remote-quoted.
  if (!validateRemotePath(a.remotePath)) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Invalid remote path: must be absolute, under /sdcard, /storage/emulated, /data/local/tmp, /cache or /data/data, free of shell metacharacters and '..'.",
        },
      ],
      isError: true,
    };
  }
  const r = await run("adb", [...adb(a.deviceId), "shell", "rm", "-rf", shquote(a.remotePath)], {
    timeout: 60_000,
  });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbUninstall(a: z.infer<typeof ToolSchemas.adbUninstall>) {
  if (!validatePackageName(a.packageName))
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "uninstall", a.packageName], {
    timeout: 120_000,
  });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbClearData(a: z.infer<typeof ToolSchemas.adbClearData>) {
  if (!validatePackageName(a.packageName))
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "pm", "clear", a.packageName], {
    timeout: 60_000,
  });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbForceStop(a: z.infer<typeof ToolSchemas.adbForceStop>) {
  if (!validatePackageName(a.packageName))
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "am", "force-stop", a.packageName], {
    timeout: 60_000,
  });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbReboot(a: z.infer<typeof ToolSchemas.adbReboot>) {
  const r = await run("adb", [...adb(a.deviceId), "reboot"], { timeout: 60_000 });
  const output = (r.stdout + r.stderr).trim();
  const prefix = a.deviceId ? `device ${a.deviceId}: ` : "";
  const message =
    r.code === 0
      ? `${prefix}${output || "rebooting"}`
      : `${prefix}reboot failed (exit ${r.code}): ${output || "no output"}`;
  return { content: [{ type: "text" as const, text: message }], isError: r.code !== 0 };
}
export async function handleAdbScreenrecord(a: z.infer<typeof ToolSchemas.adbScreenrecord>) {
  const dur = Math.max(1, a.durationSec ?? 10);
  const remote = "/sdcard/screenrecord.mp4";
  const local = a.outputPath ?? `screenrecord-${Date.now()}.mp4`;
  const r = await run(
    "adb",
    [...adb(a.deviceId), "shell", "screenrecord", "--time-limit", String(dur), remote],
    { timeout: (dur + 5) * 1000 },
  );
  if (r.code !== 0)
    return {
      content: [{ type: "text" as const, text: `screenrecord failed: ${r.stderr}` }],
      isError: true,
    };
  const r2 = await run("adb", [...adb(a.deviceId), "pull", remote, local], { timeout: 120_000 });
  return {
    content: [{ type: "text" as const, text: `saved ${local}\n${r2.stdout + r2.stderr}` }],
    isError: r2.code !== 0,
  };
}
export async function handleAdbInput(a: z.infer<typeof ToolSchemas.adbInput>) {
  const base = adb(a.deviceId);
  let args: string[] = [];
  switch (a.action) {
    case "tap":
      args = [...base, "shell", "input", "tap", String(a.x ?? 0), String(a.y ?? 0)];
      break;
    case "swipe":
      args = [
        ...base,
        "shell",
        "input",
        "swipe",
        String(a.x ?? 0),
        String(a.y ?? 0),
        String(a.x2 ?? 0),
        String(a.y2 ?? 0),
      ];
      break;
    // Issue 67: text is user-controlled; %s keeps `input text` spaces working
    // and shquote keeps it one remote argument.
    case "text":
      args = [...base, "shell", "input", "text", shquote((a.text ?? "").replace(/ /g, "%s"))];
      break;
    case "keyevent": {
      const kc = a.keycode ?? "KEYCODE_ENTER";
      if (!/^[A-Za-z0-9_]+$/.test(kc))
        return { content: [{ type: "text" as const, text: "Invalid keycode." }], isError: true };
      args = [...base, "shell", "input", "keyevent", kc];
      break;
    }
  }
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbDeepLink(a: z.infer<typeof ToolSchemas.adbDeepLink>) {
  // Issue 67: the URI is remote-shell-quoted so '&' and friends survive the
  // device shell as one argument; an optional package uses the dedicated -p
  // flag instead of a positional.
  if (a.packageName && !validatePackageName(a.packageName)) {
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  }
  const args = [
    ...adb(a.deviceId),
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    shquote(a.uri),
  ];
  if (a.packageName) args.push("-p", shquote(a.packageName));
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbBroadcast(a: z.infer<typeof ToolSchemas.adbBroadcast>) {
  if (!validateIntentAction(a.action)) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Invalid action: must be a dotted intent action with no shell metacharacters.",
        },
      ],
      isError: true,
    };
  }
  // Extras are remote-shell-quoted too; each must stay one remote argument.
  const args = [
    ...adb(a.deviceId),
    "shell",
    "am",
    "broadcast",
    "-a",
    a.action,
    ...(a.extras ?? []).map(shquote),
  ];
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbServiceStart(a: z.infer<typeof ToolSchemas.adbServiceStart>) {
  if (!validateComponent(a.component)) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Invalid component: must be package/class with no shell metacharacters.",
        },
      ],
      isError: true,
    };
  }
  const r = await run(
    "adb",
    [...adb(a.deviceId), "shell", "am", "startservice", "-n", shquote(a.component)],
    { timeout: 30_000 },
  );
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbWifi(a: z.infer<typeof ToolSchemas.adbWifi>) {
  const base = adb(a.deviceId);
  let args: string[] = [];
  if (a.action === "tcpip") args = [...base, "tcpip", String(a.port ?? 5555)];
  else if (a.action === "connect")
    args = [...base, "connect", `${a.host ?? "127.0.0.1"}:${a.port ?? 5555}`];
  else args = [...base, "disconnect", `${a.host ?? "127.0.0.1"}:${a.port ?? 5555}`];
  const r = await run("adb", args, { timeout: 30_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAdbBattery(a: z.infer<typeof ToolSchemas.adbBattery>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "dumpsys", "battery"], {
    timeout: 30_000,
  });
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
  if (a.pattern) {
    try {
      const re = new RegExp(a.pattern, "m");
      lines = lines.filter((l) => re.test(l));
    } catch {
      return { content: [{ type: "text" as const, text: `Invalid pattern regex` }], isError: true };
    }
  }
  if (a.packageName) lines = lines.filter((l) => l.includes(a.packageName!));
  const total = (r.stdout || "").split("\n").filter((l) => l.trim()).length;
  const text = [
    `total=${total} matched=${lines.length} shown=${Math.min(lines.length, 500)}`,
    ...lines.slice(0, 500),
  ].join("\n");
  return { content: [{ type: "text" as const, text }], isError: r.code !== 0 };
}
export async function handleAnrCheck(a: z.infer<typeof ToolSchemas.anrCheck>) {
  const r = await run("adb", [...adb(a.deviceId), "shell", "cat", "/data/anr/traces.txt"], {
    timeout: 30_000,
  });
  const text = r.stdout || r.stderr;
  const anr = /ANR in|Application Not Responding/i.test(text);
  return {
    content: [{ type: "text" as const, text: `anr_detected=${anr}\n${text.slice(0, 8000)}` }],
    isError: r.code !== 0,
  };
}
async function resolveCrashSummarySerial(deviceId?: string): Promise<string> {
  if (deviceId) return deviceId;
  const r = await run("adb", ["get-serialno"], { timeout: 15_000 });
  const serial = r.stdout.trim();
  return r.code === 0 && serial && serial !== "unknown" ? serial : "(default)";
}
export async function handleCrashSummary(a: z.infer<typeof ToolSchemas.crashSummary>) {
  const base = adb(a.deviceId);
  const serial = await resolveCrashSummarySerial(a.deviceId);
  const durationSec = Math.max(0, a.durationSec ?? 10);
  const startedAt = new Date().toISOString();
  const header = (status: string) =>
    [
      `status=${status}`,
      `device=${serial}`,
      `window=${startedAt}..${new Date().toISOString()}`,
      `duration=${durationSec}s`,
    ].join("\n");

  const clear = await run("adb", [...base, "logcat", "-c"], { timeout: 30_000 });
  if (clear.code !== 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${header("not-assessed")}\ncrashes=unavailable\nlogcat -c failed (exit ${clear.code}): ${clear.stderr.trim()}`,
        },
      ],
      isError: true,
    };
  }

  await new Promise((res) => setTimeout(res, durationSec * 1000));
  const r = await run("adb", [...base, "logcat", "-d"], { timeout: 120_000 });
  if (r.code !== 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${header("unavailable")}\ncrashes=unavailable\nlogcat -d failed (exit ${r.code}): ${r.stderr.trim()}`,
        },
      ],
      isError: true,
    };
  }

  const crashes = (r.stdout || "")
    .split("\n")
    .filter((l) => /FATAL EXCEPTION|AndroidRuntime/i.test(l));
  const status = crashes.length > 0 ? "crashes-found" : "no-crashes-observed";
  return {
    content: [
      {
        type: "text" as const,
        text: `${header(status)}\ncrashes=${crashes.length}\n${crashes.slice(0, 50).join("\n")}`,
      },
    ],
    isError: false,
  };
}
// UI inspection
export async function handleUiDump(a: z.infer<typeof ToolSchemas.uiDump>) {
  const remote = "/sdcard/window_dump.xml";
  const local = a.outputPath ?? `/tmp/ui-dump-${Date.now()}.xml`;
  const base = adb(a.deviceId);
  let r = await run("adb", [...base, "shell", "uiautomator", "dump", remote], { timeout: 60_000 });
  if (r.code !== 0)
    return {
      content: [{ type: "text" as const, text: `uiautomator dump failed: ${r.stderr}` }],
      isError: true,
    };
  r = await run("adb", [...base, "pull", remote, local], { timeout: 60_000 });
  return {
    content: [{ type: "text" as const, text: `saved ${local}\n${r.stdout + r.stderr}` }],
    isError: r.code !== 0,
  };
}
export async function handleComposeRecomposition(
  a: z.infer<typeof ToolSchemas.composeRecomposition>,
) {
  const base = adb(a.deviceId);
  // Issue 67: the optional package filter gets the same validation as every
  // other package-typed input.
  if (a.packageName && !validatePackageName(a.packageName)) {
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  }
  const r = await run(
    "adb",
    [...base, "shell", "dumpsys", "activity", a.packageName ? shquote(a.packageName) : ""].filter(
      Boolean,
    ),
    { timeout: 60_000 },
  );
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(0, 8000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleLayoutBounds(a: z.infer<typeof ToolSchemas.layoutBounds>) {
  const base = adb(a.deviceId);
  const val = a.enabled ? "true" : "false";
  const r = await run("adb", [...base, "shell", "setprop", "debug.layout", val], {
    timeout: 30_000,
  });
  return {
    content: [{ type: "text" as const, text: `debug.layout=${val}\n${r.stdout + r.stderr}` }],
    isError: r.code !== 0,
  };
}
// Emulator management
// Issue 68: avd names are caller-controlled values passed next to option
// flags; a leading '-' could be parsed as a flag instead of the name.
export async function handleAvdCreate(a: z.infer<typeof ToolSchemas.avdCreate>) {
  if (!notOptionLike(a.avdName))
    return {
      content: [{ type: "text" as const, text: "Invalid avd name: must not start with '-'." }],
      isError: true,
    };
  const r = await run(
    "avdmanager",
    ["create", "avd", "-n", a.avdName, "-k", a.systemImage, "-d", a.device],
    { timeout: 120_000 },
  );
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
export async function handleAvdDelete(a: z.infer<typeof ToolSchemas.avdDelete>) {
  if (!notOptionLike(a.avdName))
    return {
      content: [{ type: "text" as const, text: "Invalid avd name: must not start with '-'." }],
      isError: true,
    };
  const r = await run("avdmanager", ["delete", "avd", "-n", a.avdName], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
const AVD_NAME_RE = /^[A-Za-z0-9._-]+$/;
const WIPE_POLL_MS = 250;

async function waitForExit(
  child: import("node:child_process").ChildProcess,
  ms: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    child.once("exit", onExit);
  });
}

async function stopManagedChild(child: import("node:child_process").ChildProcess): Promise<string> {
  if (!child.pid) return "not-spawned";
  if (child.exitCode !== null || child.signalCode !== null) return "already-exited";
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return "terminated";
  child.kill("SIGKILL");
  return (await waitForExit(child, 2_000)) ? "force-killed" : "still-running";
}

async function runningEmulatorSerials(): Promise<string[] | null> {
  const r = await run("adb", ["devices"], { timeout: 15_000 });
  if (r.code !== 0) return null;
  return r.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((serial) => /^emulator-\d+$/.test(serial));
}

async function emulatorAvdName(serial: string): Promise<string | null> {
  const r = await run("adb", ["-s", serial, "emu", "avd", "name"], { timeout: 15_000 });
  if (r.code !== 0) return null;
  const name = r.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && line !== "OK");
  return name ?? null;
}

// Issue 86: wipe is a bounded lifecycle, not a long-running `emulator` call
// under a generic timeout. The tool resolves the exact AVD, refuses to touch a
// running target, starts one controlled instance, waits for the reset to reach
// boot completion, then shuts down that exact ADB serial and waits for the
// child to exit. It never reads PID files, so a stale record cannot terminate
// an unrelated process, and it never kills emulator processes by name.
export async function handleAvdWipe(a: z.infer<typeof ToolSchemas.avdWipe>) {
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  if (!notOptionLike(a.avdName) || !AVD_NAME_RE.test(a.avdName))
    return fail(`Invalid avd name: ${a.avdName}`);

  const listed = await run("emulator", ["-list-avds"], { timeout: 30_000 });
  if (listed.code !== 0)
    return fail(
      `status=unavailable\navd=${a.avdName}\nreason=emulator -list-avds failed (exit ${listed.code}): ${listed.stderr.trim()}`,
    );
  const avds = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!avds.includes(a.avdName))
    return fail(
      `status=not-found\navd=${a.avdName}\nwipe=not-started\navailable=${avds.join(",") || "(none)"}`,
    );

  const before = await runningEmulatorSerials();
  if (before === null)
    return fail(
      `status=unavailable\navd=${a.avdName}\nreason=adb devices failed; cannot prove the target is stopped`,
    );
  for (const serial of before) {
    if ((await emulatorAvdName(serial)) === a.avdName)
      return fail(
        `status=refused\navd=${a.avdName}\nreason=already-running\nserial=${serial}\nwipe=not-started\n` +
          `Refusing to wipe a running AVD. Stop it explicitly first.`,
      );
  }

  const deadline = Date.now() + Math.max(1, a.timeoutSec ?? 300) * 1000;
  const { spawn } = await import("node:child_process");
  const child = spawn(
    "emulator",
    [
      "-avd",
      a.avdName,
      "-wipe-data",
      "-no-window",
      "-no-audio",
      "-no-snapshot-save",
      "-gpu",
      "swiftshader_indirect",
    ],
    { stdio: "ignore" },
  );
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err;
  });

  let serial: string | null = null;
  while (!serial && Date.now() < deadline) {
    if (spawnError) break;
    const now = await runningEmulatorSerials();
    for (const candidate of (now ?? []).filter((s) => !before.includes(s))) {
      if ((await emulatorAvdName(candidate)) === a.avdName) {
        serial = candidate;
        break;
      }
    }
    if (!serial) await sleep(WIPE_POLL_MS);
  }
  if (!serial) {
    const instance = await stopManagedChild(child);
    const reason = spawnError
      ? `emulator failed to spawn: ${(spawnError as Error).message}`
      : "no matching emulator serial became ready before the deadline";
    return fail(
      `status=timeout\navd=${a.avdName}\nphase=serial\nwipe=indeterminate\ninstance=${instance}\nreason=${reason}`,
    );
  }

  let booted = false;
  while (!booted && Date.now() < deadline) {
    const r = await run("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
      timeout: 15_000,
    });
    if (r.code === 0 && r.stdout.trim() === "1") booted = true;
    else await sleep(WIPE_POLL_MS);
  }
  if (!booted) {
    // Best effort: ask this exact serial to stop, then terminate only the
    // child this operation spawned.
    await run("adb", ["-s", serial, "emu", "kill"], { timeout: 30_000 }).catch(() => undefined);
    const instance = await stopManagedChild(child);
    return fail(
      `status=timeout\navd=${a.avdName}\nserial=${serial}\nphase=boot\nwipe=indeterminate\ninstance=${instance}\n` +
        `reason=sys.boot_completed was not observed before the deadline; reset state is unknown`,
    );
  }

  const kill = await run("adb", ["-s", serial, "emu", "kill"], { timeout: 30_000 });
  const exited = await waitForExit(child, 30_000);
  if (kill.code !== 0 || !exited) {
    const instance = await stopManagedChild(child);
    return fail(
      `status=shutdown-failed\navd=${a.avdName}\nserial=${serial}\nwipe=complete\nshutdown=failed\ninstance=${instance}\n` +
        `reason=${kill.code !== 0 ? `emu kill exited ${kill.code}: ${kill.stderr.trim()}` : "emulator process did not exit"} ` +
        `The AVD was not confirmed stopped.`,
    );
  }

  return {
    content: [
      {
        type: "text" as const,
        text:
          `status=ok\navd=${a.avdName}\nserial=${serial}\nwipe=complete\nboot=sys.boot_completed=1\n` +
          `instance=stopped\nUser data was reset; AVD configuration and snapshots were preserved.`,
      },
    ],
    isError: false,
  };
}
export async function handleEmulatorSnapshot(a: z.infer<typeof ToolSchemas.emulatorSnapshot>) {
  const base = adb(a.deviceId);
  if (a.action === "list") {
    const r = await run("adb", [...base, "emu", "avd", "snapshot", "list"], { timeout: 30_000 });
    return {
      content: [{ type: "text" as const, text: r.stdout + r.stderr }],
      isError: r.code !== 0,
    };
  }
  const name = a.name ?? "default";
  const cmd =
    a.action === "save"
      ? ["emu", "avd", "snapshot", "save", name]
      : ["emu", "avd", "snapshot", "load", name];
  const r = await run("adb", [...base, ...cmd], { timeout: 60_000 });
  return { content: [{ type: "text" as const, text: r.stdout + r.stderr }], isError: r.code !== 0 };
}
// Static analysis
async function unzipList(apkPath: string): Promise<string> {
  const r = await run("unzip", ["-l", apkPath], { timeout: 120_000 });
  return r.stdout + r.stderr;
}
export async function handleApkInfo(a: z.infer<typeof ToolSchemas.apkInfo>) {
  if (!notOptionLike(a.apkPath))
    return {
      content: [{ type: "text" as const, text: "Invalid apk path: must not start with '-'." }],
      isError: true,
    };
  const r = await run("aapt2", ["dump", "badging", a.apkPath], { timeout: 120_000 });
  if (r.code !== 0) {
    // fallback to unzip listing
    const u = await unzipList(a.apkPath);
    return {
      content: [
        {
          type: "text" as const,
          text: `aapt2 unavailable/failed; zip listing:\n${u.slice(0, 12000)}`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: r.stdout.slice(0, 12000) }], isError: false };
}
export async function handleApkDecompile(a: z.infer<typeof ToolSchemas.apkDecompile>) {
  // Issue 69: refuse to point the decompiler at an existing directory unless
  // the caller explicitly opts into replacement; default destinations are
  // unique (mkdtemp), not bare-timestamp names.
  if (!notOptionLike(a.apkPath))
    return {
      content: [{ type: "text" as const, text: "Invalid apk path: must not start with '-'." }],
      isError: true,
    };
  try {
    const info = await stat(a.apkPath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    return {
      content: [{ type: "text" as const, text: `Input APK not found or unreadable: ${a.apkPath}` }],
      isError: true,
    };
  }
  const { existsSync } = await import("node:fs");
  let out = a.outputDir;
  if (out) {
    if (!notOptionLike(out))
      return {
        content: [{ type: "text" as const, text: "Invalid output dir: must not start with '-'." }],
        isError: true,
      };
    if (existsSync(out) && !a.overwrite) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Refusing to overwrite existing directory ${out}. Pass overwrite:true to replace it.`,
          },
        ],
        isError: true,
      };
    }
  } else {
    out = await tmpDir("android-mcp-decompiled-");
  }
  const tool = a.tool === "apktool" ? "apktool" : "jadx";
  // apktool -f (force overwrite) only with the explicit opt-in.
  const args =
    tool === "apktool"
      ? ["d", a.apkPath, "-o", out, ...(a.overwrite ? ["-f"] : [])]
      : ["-d", out, a.apkPath];
  const r = await run(tool, args, { timeout: 600_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `tool=${tool} out=${out}\nexit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-8000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleManifestInspect(a: z.infer<typeof ToolSchemas.manifestInspect>) {
  const r = await run("aapt2", ["dump", "xmltree", a.apkPath, "AndroidManifest.xml"], {
    timeout: 120_000,
  });
  if (r.code !== 0)
    return {
      content: [{ type: "text" as const, text: `aapt2 failed: ${r.stderr}` }],
      isError: true,
    };
  return { content: [{ type: "text" as const, text: r.stdout.slice(0, 20000) }], isError: false };
}
export async function handlePrivacyScan(a: z.infer<typeof ToolSchemas.privacyScan>) {
  try {
    const result = await scanPrivacyProject(a.projectPath, {
      declarationsPath: a.declarationsPath,
    });
    let text = renderPrivacyReport(result);
    if (a.reportPath) {
      await mkdir(dirname(a.reportPath), { recursive: true });
      await writeFile(a.reportPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      text += `\nReport written to ${a.reportPath}`;
    }
    const blockers = result.findings.filter((finding) => finding.severity === "blocker").length;
    return {
      content: [{ type: "text" as const, text }],
      isError: Boolean(a.strict && blockers > 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `privacy_scan failed: ${message}` }],
      isError: true,
    };
  }
}
export async function handleSecretScan(a: z.infer<typeof ToolSchemas.secretScan>) {
  try {
    const result = await scanProjectSecrets({
      projectPath: a.projectPath,
      severityThreshold: a.severityThreshold,
    });
    const lines: string[] = [
      "# Secret scan",
      "",
      `Scanned ${result.scannedFiles} file(s) under ${result.projectPath}.`,
      `Findings: ${result.findings.length} (values redacted).`,
      "",
    ];
    for (const f of result.findings) {
      lines.push(
        `## [${f.severity}/${f.confidence}] ${f.rule} — ${f.file}:${f.line}:${f.column}`,
        "",
        `Evidence: ${f.snippet}`,
        `Remediation: ${f.remediation}`,
        "",
      );
    }
    if (result.excludedPaths.length > 0) {
      lines.push(
        `Excluded ${result.excludedPaths.length} path(s) (binaries/keystores/build dirs):`,
        ...result.excludedPaths.slice(0, 50).map((p) => `- ${p}`),
        "",
      );
    }
    if (result.allowlist.length > 0) {
      lines.push(
        "Allowlisted:",
        ...result.allowlist.map((e) => `- ${e.rule} in ${e.file}: ${e.rationale}`),
        "",
      );
    }
    lines.push(`Scanned at ${result.scannedAt}.`);
    let text = lines.join("\n");
    if (a.reportPath) {
      await mkdir(dirname(a.reportPath), { recursive: true });
      await writeFile(a.reportPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      text += `\nReport written to ${a.reportPath}`;
    }
    return { content: [{ type: "text" as const, text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `secret_scan failed: ${message}` }],
      isError: true,
    };
  }
}
export async function handleSecurityAudit(a: z.infer<typeof ToolSchemas.securityAudit>) {
  try {
    const result = await auditProjectManifest({ projectPath: a.projectPath });
    const lines: string[] = [
      "# AndroidManifest security audit",
      "",
      `Scanned ${result.manifestPath}.`,
      `Findings: ${result.findings.length}; passed checks: ${result.passed.length}; ` +
        `accepted (baseline): ${result.accepted.length}; not assessed: ${result.notAssessed.length}.`,
      "",
    ];
    for (const f of result.findings) {
      lines.push(
        `## [${f.severity}/${f.classification}] ${f.check}`,
        "",
        `Evidence: ${f.evidence}`,
        `Why: ${f.rationale}`,
        `Remediation: ${f.remediation}`,
        "",
      );
    }
    if (result.passed.length > 0) lines.push(`Passed: ${result.passed.join(", ")}`, "");
    if (result.notAssessed.length > 0) {
      lines.push(`Not assessed (needs source/APK analysis): ${result.notAssessed.join(", ")}`, "");
    }
    if (result.accepted.length > 0) {
      lines.push(
        "Accepted by baseline:",
        ...result.accepted.map((e) => `- ${e.check} in ${e.file}: ${e.acceptedRationale}`),
        "",
      );
    }
    lines.push(`Scanned at ${result.scannedAt}.`);
    let text = lines.join("\n");
    if (a.reportPath) {
      await mkdir(dirname(a.reportPath), { recursive: true });
      await writeFile(a.reportPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      text += `\nReport written to ${a.reportPath}`;
    }
    return { content: [{ type: "text" as const, text }], isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `security_audit failed: ${message}` }],
      isError: true,
    };
  }
}
export async function handlePolicyPreflight(a: z.infer<typeof ToolSchemas.policyPreflight>) {
  try {
    const result = await runPolicyPreflight({ projectPath: a.projectPath });
    let text = renderPolicyPreflight(result);
    if (a.reportPath) {
      await mkdir(dirname(a.reportPath), { recursive: true });
      await writeFile(a.reportPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      text += `\nReport written to ${a.reportPath}`;
    }
    return {
      content: [{ type: "text" as const, text }],
      isError: Boolean(a.strict && result.summary.failed > 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `policy_preflight failed: ${message}` }],
      isError: true,
    };
  }
}
export async function handleNativeLibs(a: z.infer<typeof ToolSchemas.nativeLibs>) {
  const listing = await unzipList(a.apkPath);
  const libs = listing.split("\n").filter((l) => /\.so\b/.test(l));
  return {
    content: [
      {
        type: "text" as const,
        text: `native libs (${libs.length}):\n${libs.join("\n").slice(0, 12000)}`,
      },
    ],
  };
}
export async function handleDexStrings(a: z.infer<typeof ToolSchemas.dexStrings>) {
  const r = await run("strings", [a.apkPath], { timeout: 120_000 });
  let lines = (r.stdout || "").split("\n");
  if (a.pattern) {
    try {
      const re = new RegExp(a.pattern);
      lines = lines.filter((l) => re.test(l));
    } catch {
      return { content: [{ type: "text" as const, text: "Invalid pattern" }], isError: true };
    }
  }
  return {
    content: [{ type: "text" as const, text: lines.slice(0, 500).join("\n") }],
    isError: r.code !== 0,
  };
}
// Testing
export async function handleInstrumentedTest(a: z.infer<typeof ToolSchemas.instrumentedTest>) {
  const args = [
    `${a.module}:connectedAndroidTest`,
    ...(a.testFilter ? [`-Pandroid.testInstrumentationRunnerArguments.class=${a.testFilter}`] : []),
    ...(a.offline ? ["--offline"] : []),
    ...(a.args ?? []),
  ];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleTestCoverage(a: z.infer<typeof ToolSchemas.testCoverage>) {
  const r = await run("gradle", [`${a.module}:testDebugUnitTestCoverage`], {
    cwd: a.projectPath,
    timeout: 600_000,
  });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
export async function handleMacrobenchmark(a: z.infer<typeof ToolSchemas.macrobenchmark>) {
  const args = [`${a.module}:connectedAndroidTest`, ...(a.args ?? [])];
  const r = await run("gradle", args, { cwd: a.projectPath, timeout: 900_000 });
  return {
    content: [
      {
        type: "text" as const,
        text: `exit=${r.code}\n${(r.stdout + "\n" + r.stderr).slice(-12000)}`,
      },
    ],
    isError: r.code !== 0,
  };
}
// Profiling
export async function handlePerfettoTrace(a: z.infer<typeof ToolSchemas.perfettoTrace>) {
  const dur = Math.max(1, a.durationSec ?? 10);
  const out = a.outputPath ?? `/tmp/trace-${Date.now()}.perfetto-trace`;
  const base = adb(a.deviceId);
  const r = await run(
    "adb",
    [
      ...base,
      "shell",
      "perfetto",
      "-o",
      "/data/misc/perfetto-traces/trace.perfetto-trace",
      "-t",
      `${dur}s`,
      "sched freq idle am wm gfx view binder_driver hal dalvik camera input res memory",
    ],
    { timeout: (dur + 10) * 1000 },
  );
  if (r.code !== 0)
    return {
      content: [{ type: "text" as const, text: `perfetto failed: ${r.stderr}` }],
      isError: true,
    };
  const r2 = await run(
    "adb",
    [...base, "pull", "/data/misc/perfetto-traces/trace.perfetto-trace", out],
    { timeout: 120_000 },
  );
  return {
    content: [{ type: "text" as const, text: `saved ${out}\n${r2.stdout + r2.stderr}` }],
    isError: r2.code !== 0,
  };
}
export async function handleMemoryProfile(a: z.infer<typeof ToolSchemas.memoryProfile>) {
  if (!validatePackageName(a.packageName))
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };
  const r = await run("adb", [...adb(a.deviceId), "shell", "dumpsys", "meminfo", a.packageName], {
    timeout: 60_000,
  });
  return {
    content: [{ type: "text" as const, text: (r.stdout + "\n" + r.stderr).slice(0, 12000) }],
    isError: r.code !== 0,
  };
}
function startupComponent(packageName: string, activity?: string): string | null {
  const value = activity?.trim();
  if (!value || value.startsWith("-") || /[^A-Za-z0-9_.$/]/.test(value)) return null;
  if (value.includes("/")) {
    const [pkg, cls] = value.split("/");
    return pkg === packageName && cls ? value : null;
  }
  return `${packageName}/${value}`;
}
export async function resolveLauncherComponent(
  base: string[],
  packageName: string,
): Promise<{ component: string | null; error: string | null }> {
  const r = await run(
    "adb",
    [
      ...base,
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-c",
      "android.intent.category.LAUNCHER",
      packageName,
    ],
    { timeout: 30_000 },
  );
  if (r.code !== 0) {
    return {
      component: null,
      error: `resolve-activity failed (exit ${r.code}): ${r.stderr.trim()}`,
    };
  }
  const component =
    r.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(line))
      .pop() ?? null;
  if (!component) {
    return {
      component: null,
      error: `could not resolve launcher activity for ${packageName}: ${r.stdout.trim().slice(0, 300) || "no output"}`,
    };
  }
  return { component, error: null };
}
export async function handleStartupTime(a: z.infer<typeof ToolSchemas.startupTime>) {
  if (!validatePackageName(a.packageName))
    return { content: [{ type: "text" as const, text: "Invalid package name." }], isError: true };

  let component: string;
  if (a.activity !== undefined) {
    const built = startupComponent(a.packageName, a.activity);
    if (!built)
      return {
        content: [{ type: "text" as const, text: `Invalid activity component: ${a.activity}` }],
        isError: true,
      };
    component = built;
  } else {
    const resolved = await resolveLauncherComponent(adb(a.deviceId), a.packageName);
    if (!resolved.component)
      return {
        content: [{ type: "text" as const, text: resolved.error ?? "launcher resolution failed" }],
        isError: true,
      };
    component = resolved.component;
  }

  const iters = Math.max(1, Math.min(a.iterations ?? 5, 50));
  const lines: string[] = [
    `package=${a.packageName}`,
    `activity=${component}`,
    `iterations=${iters}`,
  ];
  let failures = 0;
  let measured = 0;
  for (let i = 0; i < iters; i++) {
    const start = await run(
      "adb",
      [...adb(a.deviceId), "shell", "am", "start-activity", "-W", "-n", component],
      { timeout: 60_000 },
    );
    const timeMs = /TotalTime:\s*(\d+)/.exec(start.stdout)?.[1];
    const stop = await run(
      "adb",
      [...adb(a.deviceId), "shell", "am", "force-stop", a.packageName],
      {
        timeout: 30_000,
      },
    );
    let result: string;
    if (start.code !== 0) {
      result = "failed";
      failures++;
    } else if (!timeMs) {
      result = "metric-unavailable";
      failures++;
    } else if (stop.code !== 0) {
      result = "measured-with-cleanup-failure";
      failures++;
      measured++;
    } else {
      result = "measured";
      measured++;
    }
    lines.push(
      `iteration=${i + 1} component=${component} launch_exit=${start.code} ` +
        `time_ms=${timeMs ?? "unavailable"} cleanup=${stop.code === 0 ? "ok" : "force-stop-failed"} ` +
        `result=${result}`,
    );
    if (start.code !== 0 || !timeMs) {
      const diagnostic = (start.stderr || start.stdout).trim().split("\n").slice(0, 5).join(" | ");
      if (diagnostic) lines.push(`  diagnostic: ${diagnostic}`);
    }
    if (stop.code !== 0) {
      lines.push(`  cleanup diagnostic: ${stop.stderr.trim().slice(0, 300) || "no output"}`);
    }
  }
  const summary = failures === 0 ? "ok" : measured > 0 ? "partial" : "failed";
  lines.push(`summary=${summary}`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: failures > 0 };
}
// Multi-device
export async function handleAdbParallel(a: z.infer<typeof ToolSchemas.adbParallel>) {
  const devices =
    a.deviceIds && a.deviceIds.length
      ? a.deviceIds
      : await (async () => {
          const r = await run("adb", ["devices"]);
          return r.stdout
            .split("\n")
            .slice(1)
            .map((l) => l.split(/\s+/)[0])
            .filter(Boolean);
        })();
  const results = await Promise.all(
    devices.map(async (d) => {
      const r = await run("adb", ["-s", d, "shell", a.command], { timeout: 60_000 });
      return `=== ${d} (exit ${r.code}) ===\n${(r.stdout + r.stderr).slice(0, 4000)}`;
    }),
  );
  return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
}
// APK serving (localhost by default, python http.server in the APK output dir)
// Issues 65/66: discovery is pure Node fs traversal (no shell), the server
// binds to loopback unless the caller explicitly opts into LAN exposure, the
// default served dir is a fresh private mkdtemp, and repeated starts kill the
// previous listener instead of orphaning it. State path (serveStatePath() from
// util.js) is env-overridable for tests via ANDROID_MCP_SERVE_STATE.
async function findFirstApk(root: string, maxFiles = 500, maxDepth = 4): Promise<string> {
  const fs = await import("node:fs");
  const stack: Array<[string, number]> = [[root, 0]];
  let scanned = 0;
  while (stack.length && scanned < maxFiles) {
    const [dir, depth] = stack.pop()!;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned >= maxFiles) break;
      scanned++;
      const full = `${dir}/${e.name}`;
      if (e.isFile() && e.name.endsWith(".apk")) return full;
      if (e.isDirectory() && depth < maxDepth) stack.push([full, depth + 1]);
    }
  }
  return "";
}
interface ServeState {
  pid?: number;
  port?: number;
  dir?: string;
  bind?: string;
  startedAt?: string;
}

function readServeState(): ServeState | null {
  try {
    const parsed = JSON.parse(readFileSync(serveStatePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ServeState) : null;
  } catch {
    return null;
  }
}

function removeServeState(): void {
  try {
    unlinkSync(serveStatePath());
  } catch {
    /* already gone */
  }
}

// Issue 81: a stale state file may point at a PID that now belongs to an
// unrelated process. Verify the command line still matches the recorded
// server (port, bind and directory) before signalling anything.
async function serveProcessCommand(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    const r = await run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { timeout: 15_000 },
    );
    return r.code === 0 ? r.stdout.trim() || null : null;
  }
  const r = await run("ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 15_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

function serveCommandMatches(state: ServeState, command: string): boolean {
  if (!/http\.server/.test(command)) return false;
  const normalized = command.replaceAll("\\", "/");
  const dir = String(state.dir ?? "").replaceAll("\\", "/");
  return (
    Boolean(dir) &&
    command.includes(String(state.port ?? "")) &&
    command.includes(String(state.bind ?? "")) &&
    normalized.includes(dir)
  );
}

async function servePidRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await servePidRunning(pid))) return true;
    await sleep(100);
  }
  return !(await servePidRunning(pid));
}

async function terminateServeState(
  state: ServeState,
): Promise<{ ok: boolean; detail: string; unowned?: boolean }> {
  const pid = state.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) return { ok: true, detail: "no-valid-pid" };
  if (!(await servePidRunning(pid))) return { ok: true, detail: "already-exited" };
  const command = await serveProcessCommand(pid);
  if (!command || !serveCommandMatches(state, command)) {
    return { ok: false, detail: "identity-unverified", unowned: true };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { ok: true, detail: "already-exited" };
  }
  if (await waitForPidExit(pid, 5_000)) return { ok: true, detail: "stopped" };
  return { ok: false, detail: "stop-timeout" };
}

async function httpProbe(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  const http = await import("node:http");
  return await new Promise<boolean>((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

export async function handleApkServe(a: z.infer<typeof ToolSchemas.apkServe>) {
  if (a.action === "stop") {
    const state = readServeState();
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "status=stopped\nserver=not-running" }],
        isError: false,
      };
    }
    const result = await terminateServeState(state);
    removeServeState();
    if (!result.ok) {
      const reason = result.unowned
        ? `identity-unverified: state pid ${state.pid} does not match a running apk server; refused to signal it`
        : `stop-timeout: state pid ${state.pid} did not exit after SIGTERM`;
      return {
        content: [{ type: "text" as const, text: `status=not-stopped\nreason=${reason}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `status=stopped\nserver=${result.detail}\nport=${state.port ?? "unknown"}\ndir=${state.dir ?? "unknown"}`,
        },
      ],
      isError: false,
    };
  }
  const port = a.port ?? 8000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      content: [{ type: "text" as const, text: `Invalid port: ${port} (expected 1-65535)` }],
      isError: true,
    };
  }
  // Issue 66: default to a fresh private temp dir, never /tmp wholesale.
  const createdDir = a.dir === undefined;
  const dir = a.dir ?? (await tmpDir("android-mcp-serve-"));
  const { existsSync } = await import("node:fs");
  if (!existsSync(dir)) {
    if (createdDir) await cleanup(dir);
    return {
      content: [{ type: "text" as const, text: `Directory does not exist: ${dir}` }],
      isError: true,
    };
  }
  // Issue 66: loopback-only unless the caller explicitly opts into LAN exposure.
  const bind = a.expose ? "0.0.0.0" : "127.0.0.1";
  const probeHost = bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const failStart = async (status: string, reason: string) => {
    if (createdDir) await cleanup(dir);
    return {
      content: [
        {
          type: "text" as const,
          text: `status=${status}\ndir=${dir}\nport=${port}\nreason=${reason}`,
        },
      ],
      isError: true,
    };
  };

  // Issue 66: stop any previous listener before starting a new one — a second
  // start must never orphan the first server. Issue 81: only signal it when
  // the recorded identity still matches; never trust a bare stale PID.
  const previous = readServeState();
  if (previous) {
    const result = await terminateServeState(previous);
    if (!result.ok && !result.unowned)
      return failStart(
        "previous-server-not-stopped",
        `${result.detail}: state pid ${previous.pid} did not exit; refusing to start another server`,
      );
    removeServeState();
  }

  const { spawn } = await import("node:child_process");
  const child = spawn(
    "python3",
    ["-m", "http.server", String(port), "--directory", dir, "--bind", bind],
    { detached: true, stdio: "ignore" },
  );
  let spawnError: Error | null = null;
  let exited = false;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const readyTimeoutMs = Math.max(1, a.readyTimeoutSec ?? 10) * 1000;
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (exited || child.exitCode !== null || child.signalCode !== null) break;
    if (await httpProbe(probeHost, port)) {
      ready = true;
      break;
    }
    await sleep(100);
  }
  if (!ready) {
    const exitedEarly = exited || child.exitCode !== null || child.signalCode !== null;
    await stopManagedChild(child);
    if (spawnError)
      return failStart(
        "exited",
        `could not start python3: ${(spawnError as NodeJS.ErrnoException).message}`,
      );
    if (exitedEarly)
      return failStart(
        "exited",
        `python3 exited before the server became ready (exit ${child.exitCode ?? "signal"})`,
      );
    return failStart(
      "timeout",
      `no HTTP response from http://${probeHost}:${port}/ within ${readyTimeoutMs}ms; child terminated`,
    );
  }
  // Readiness and liveness are separate facts: do not persist state for a
  // process that answered once and then died.
  if (exited || child.exitCode !== null || child.signalCode !== null) {
    await stopManagedChild(child);
    return failStart("exited", "python3 exited immediately after readiness");
  }

  const fs = await import("node:fs");
  try {
    fs.mkdirSync(dirname(serveStatePath()), { recursive: true });
    fs.writeFileSync(
      serveStatePath(),
      JSON.stringify({
        pid: child.pid,
        port,
        dir,
        bind,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(serveStatePath(), 0o600);
    } catch {
      /* best effort */
    }
  } catch (error) {
    await stopManagedChild(child);
    const message = error instanceof Error ? error.message : String(error);
    return failStart("state-write-failed", message);
  }

  // Issue 65: no execSync/find — pure fs traversal for a reportable apk path.
  const apk = await findFirstApk(dir);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `status=ready\npid=${child.pid}\nserving ${dir} on http://${bind}:${port}/` +
          `${a.expose ? " (all interfaces — explicit expose opt-in)" : " (localhost only)"}\n` +
          `${apk ? "apk: " + apk : "no .apk found in dir"}\nstop with apk_serve action=stop`,
      },
    ],
    isError: false,
  };
}
