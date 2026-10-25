import { z } from "zod";
import { join } from "node:path";
import {
  run,
  which,
  tmpDir,
  readBase64,
  cleanup,
  validateGradleTask,
  validatePackageName,
} from "./util.js";

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
