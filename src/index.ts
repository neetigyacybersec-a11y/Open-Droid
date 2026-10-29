#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolSchemas } from "./tools.js";
import * as H from "./tools.js";

const server = new McpServer(
  { name: "android-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

function logged(name: string, fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    const t0 = Date.now();
    console.error(`[android-mcp] ${name} start`);
    try {
      const res = await fn(args);
      console.error(`[android-mcp] ${name} ok (${Date.now() - t0}ms)`);
      return res;
    } catch (e) {
      console.error(`[android-mcp] ${name} error (${Date.now() - t0}ms):`, e);
      throw e;
    }
  };
}

server.registerTool("android_env_check", { description: "Check installed Android toolchain (java, gradle, adb, emulator, sdkmanager, maestro, compose-preview, android CLI) and env vars.", inputSchema: ToolSchemas.envCheck }, logged("android_env_check", async () => H.handleEnvCheck()));
server.registerTool("gradle_task", { description: "Run a Gradle task in a project directory.", inputSchema: ToolSchemas.gradle }, logged("gradle_task", async (a: any) => H.handleGradle(a)));
server.registerTool("adb_devices", { description: "List connected Android devices/emulators.", inputSchema: ToolSchemas.adbDevices }, logged("adb_devices", async () => H.handleAdbDevices()));
server.registerTool("adb_screenshot", { description: "Capture a screenshot from a device/emulator and return it as an image.", inputSchema: ToolSchemas.adbScreenshot }, logged("adb_screenshot", async (a: any) => H.handleAdbScreenshot(a)));
server.registerTool("adb_install", { description: "Install an APK on a device/emulator.", inputSchema: ToolSchemas.adbInstall }, logged("adb_install", async (a: any) => H.handleAdbInstall(a)));
server.registerTool("adb_launch", { description: "Launch an app package (and optional activity).", inputSchema: ToolSchemas.adbLaunch }, logged("adb_launch", async (a: any) => H.handleAdbLaunch(a)));
server.registerTool("emulator_list_avds", { description: "List available Android Virtual Devices.", inputSchema: ToolSchemas.emulatorList }, logged("emulator_list_avds", async () => H.handleEmulatorList()));
server.registerTool("emulator_boot", { description: "Boot an AVD (headless by default).", inputSchema: ToolSchemas.emulatorBoot }, logged("emulator_boot", async (a: any) => H.handleEmulatorBoot(a)));
server.registerTool("maestro_run", { description: "Run a Maestro flow YAML against a device.", inputSchema: ToolSchemas.maestroRun }, logged("maestro_run", async (a: any) => H.handleMaestroRun(a)));
server.registerTool("compose_preview_render", { description: "Render Compose @Preview composables to PNG via compose-preview CLI (if installed).", inputSchema: ToolSchemas.composePreviewRender }, logged("compose_preview_render", async (a: any) => H.handleComposePreviewRender(a)));
server.registerTool("android_skills_list", { description: "List available Android skills via the Android CLI (if installed).", inputSchema: ToolSchemas.skillsList }, logged("android_skills_list", async () => H.handleSkillsList()));
server.registerTool("android_skills_search", { description: "Search Android skills via the Android CLI.", inputSchema: ToolSchemas.skillsSearch }, logged("android_skills_search", async (a: any) => H.handleSkillsSearch(a)));
server.registerTool("sdkmanager_install", { description: "Install Android SDK packages via sdkmanager.", inputSchema: ToolSchemas.sdkmanagerInstall }, logged("sdkmanager_install", async (a: any) => H.handleSdkmanagerInstall(a)));
server.registerTool("adb_shell", { description: "Raw shell command passthrough to a device/emulator (high-trust; no blocklist).", inputSchema: ToolSchemas.adbShell }, logged("adb_shell", async (a: any) => H.handleAdbShell(a)));
server.registerTool("adb_logcat", { description: "Capture filtered device logcat (clear, wait, dump, regex-filter).", inputSchema: ToolSchemas.adbLogcat }, logged("adb_logcat", async (a: any) => H.handleAdbLogcat(a)));
server.registerTool("runtime_dump", { description: "Structured dumpsys probes: activity, service, package, meminfo.", inputSchema: ToolSchemas.runtimeDump }, logged("runtime_dump", async (a: any) => H.handleRuntimeDump(a)));
server.registerTool("frida_ps", { description: "Ensure frida-server is running on the device, then list installed apps and running processes.", inputSchema: ToolSchemas.fridaPs }, logged("frida_ps", async (a: any) => H.handleFridaPs(a)));
server.registerTool("frida_hook", { description: "Spawn or attach to an app and run an inline or file-based Frida hook script for a bounded duration, returning its console output.", inputSchema: ToolSchemas.fridaHook }, logged("frida_hook", async (a: any) => H.handleFridaHook(a)));
server.registerTool("frida_trace_methods", { description: "Trace a Java class's methods by regex, logging each call's arguments and return value.", inputSchema: ToolSchemas.fridaTraceMethods }, logged("frida_trace_methods", async (a: any) => H.handleFridaTraceMethods(a)));
server.registerTool("net_capture", { description: "Start or stop a single mitmproxy capture session. Start roots the device, installs the mitmproxy CA (best-effort), points the device HTTP proxy at the host, and writes a HAR file; auto-stops after durationSec.", inputSchema: ToolSchemas.netCapture }, logged("net_capture", async (a: any) => H.handleNetCapture(a)));

server.registerTool("gradle_test", { description: "gradle_test tool.", inputSchema: ToolSchemas.gradleTest }, logged("gradle_test", async (a: any) => H.handleGradleTest(a)));
server.registerTool("gradle_lint", { description: "gradle_lint tool.", inputSchema: ToolSchemas.gradleLint }, logged("gradle_lint", async (a: any) => H.handleGradleLint(a)));
server.registerTool("gradle_dependencies", { description: "gradle_dependencies tool.", inputSchema: ToolSchemas.gradleDependencies }, logged("gradle_dependencies", async (a: any) => H.handleGradleDependencies(a)));
server.registerTool("build_variant", { description: "build_variant tool.", inputSchema: ToolSchemas.buildVariant }, logged("build_variant", async (a: any) => H.handleBuildVariant(a)));
server.registerTool("baseline_profile_generate", { description: "baseline_profile_generate tool.", inputSchema: ToolSchemas.baselineProfileGenerate }, logged("baseline_profile_generate", async (a: any) => H.handleBaselineProfileGenerate(a)));
server.registerTool("adb_push", { description: "adb_push tool.", inputSchema: ToolSchemas.adbPush }, logged("adb_push", async (a: any) => H.handleAdbPush(a)));
server.registerTool("adb_pull", { description: "adb_pull tool.", inputSchema: ToolSchemas.adbPull }, logged("adb_pull", async (a: any) => H.handleAdbPull(a)));
server.registerTool("adb_rm", { description: "adb_rm tool.", inputSchema: ToolSchemas.adbRm }, logged("adb_rm", async (a: any) => H.handleAdbRm(a)));
server.registerTool("adb_uninstall", { description: "adb_uninstall tool.", inputSchema: ToolSchemas.adbUninstall }, logged("adb_uninstall", async (a: any) => H.handleAdbUninstall(a)));
server.registerTool("adb_clear_data", { description: "adb_clear_data tool.", inputSchema: ToolSchemas.adbClearData }, logged("adb_clear_data", async (a: any) => H.handleAdbClearData(a)));
server.registerTool("adb_force_stop", { description: "adb_force_stop tool.", inputSchema: ToolSchemas.adbForceStop }, logged("adb_force_stop", async (a: any) => H.handleAdbForceStop(a)));
server.registerTool("adb_reboot", { description: "adb_reboot tool.", inputSchema: ToolSchemas.adbReboot }, logged("adb_reboot", async (a: any) => H.handleAdbReboot(a)));
server.registerTool("adb_screenrecord", { description: "adb_screenrecord tool.", inputSchema: ToolSchemas.adbScreenrecord }, logged("adb_screenrecord", async (a: any) => H.handleAdbScreenrecord(a)));
server.registerTool("adb_input", { description: "adb_input tool.", inputSchema: ToolSchemas.adbInput }, logged("adb_input", async (a: any) => H.handleAdbInput(a)));
server.registerTool("adb_deep_link", { description: "adb_deep_link tool.", inputSchema: ToolSchemas.adbDeepLink }, logged("adb_deep_link", async (a: any) => H.handleAdbDeepLink(a)));
server.registerTool("adb_broadcast", { description: "adb_broadcast tool.", inputSchema: ToolSchemas.adbBroadcast }, logged("adb_broadcast", async (a: any) => H.handleAdbBroadcast(a)));
server.registerTool("adb_service_start", { description: "adb_service_start tool.", inputSchema: ToolSchemas.adbServiceStart }, logged("adb_service_start", async (a: any) => H.handleAdbServiceStart(a)));
server.registerTool("adb_wifi", { description: "adb_wifi tool.", inputSchema: ToolSchemas.adbWifi }, logged("adb_wifi", async (a: any) => H.handleAdbWifi(a)));
server.registerTool("adb_battery", { description: "adb_battery tool.", inputSchema: ToolSchemas.adbBattery }, logged("adb_battery", async (a: any) => H.handleAdbBattery(a)));
server.registerTool("logcat_filtered", { description: "logcat_filtered tool.", inputSchema: ToolSchemas.logcatFiltered }, logged("logcat_filtered", async (a: any) => H.handleLogcatFiltered(a)));
server.registerTool("anr_check", { description: "anr_check tool.", inputSchema: ToolSchemas.anrCheck }, logged("anr_check", async (a: any) => H.handleAnrCheck(a)));
server.registerTool("crash_summary", { description: "crash_summary tool.", inputSchema: ToolSchemas.crashSummary }, logged("crash_summary", async (a: any) => H.handleCrashSummary(a)));
server.registerTool("ui_dump", { description: "ui_dump tool.", inputSchema: ToolSchemas.uiDump }, logged("ui_dump", async (a: any) => H.handleUiDump(a)));
server.registerTool("compose_recomposition", { description: "compose_recomposition tool.", inputSchema: ToolSchemas.composeRecomposition }, logged("compose_recomposition", async (a: any) => H.handleComposeRecomposition(a)));
server.registerTool("layout_bounds", { description: "layout_bounds tool.", inputSchema: ToolSchemas.layoutBounds }, logged("layout_bounds", async (a: any) => H.handleLayoutBounds(a)));
server.registerTool("avd_create", { description: "avd_create tool.", inputSchema: ToolSchemas.avdCreate }, logged("avd_create", async (a: any) => H.handleAvdCreate(a)));
server.registerTool("avd_delete", { description: "avd_delete tool.", inputSchema: ToolSchemas.avdDelete }, logged("avd_delete", async (a: any) => H.handleAvdDelete(a)));
server.registerTool("avd_wipe", { description: "avd_wipe tool.", inputSchema: ToolSchemas.avdWipe }, logged("avd_wipe", async (a: any) => H.handleAvdWipe(a)));
server.registerTool("emulator_snapshot", { description: "emulator_snapshot tool.", inputSchema: ToolSchemas.emulatorSnapshot }, logged("emulator_snapshot", async (a: any) => H.handleEmulatorSnapshot(a)));
server.registerTool("apk_info", { description: "apk_info tool.", inputSchema: ToolSchemas.apkInfo }, logged("apk_info", async (a: any) => H.handleApkInfo(a)));
server.registerTool("apk_decompile", { description: "apk_decompile tool.", inputSchema: ToolSchemas.apkDecompile }, logged("apk_decompile", async (a: any) => H.handleApkDecompile(a)));
server.registerTool("manifest_inspect", { description: "manifest_inspect tool.", inputSchema: ToolSchemas.manifestInspect }, logged("manifest_inspect", async (a: any) => H.handleManifestInspect(a)));
server.registerTool("native_libs", { description: "native_libs tool.", inputSchema: ToolSchemas.nativeLibs }, logged("native_libs", async (a: any) => H.handleNativeLibs(a)));
server.registerTool("dex_strings", { description: "dex_strings tool.", inputSchema: ToolSchemas.dexStrings }, logged("dex_strings", async (a: any) => H.handleDexStrings(a)));
server.registerTool("instrumented_test", { description: "instrumented_test tool.", inputSchema: ToolSchemas.instrumentedTest }, logged("instrumented_test", async (a: any) => H.handleInstrumentedTest(a)));
server.registerTool("test_coverage", { description: "test_coverage tool.", inputSchema: ToolSchemas.testCoverage }, logged("test_coverage", async (a: any) => H.handleTestCoverage(a)));
server.registerTool("macrobenchmark", { description: "macrobenchmark tool.", inputSchema: ToolSchemas.macrobenchmark }, logged("macrobenchmark", async (a: any) => H.handleMacrobenchmark(a)));
server.registerTool("perfetto_trace", { description: "perfetto_trace tool.", inputSchema: ToolSchemas.perfettoTrace }, logged("perfetto_trace", async (a: any) => H.handlePerfettoTrace(a)));
server.registerTool("memory_profile", { description: "memory_profile tool.", inputSchema: ToolSchemas.memoryProfile }, logged("memory_profile", async (a: any) => H.handleMemoryProfile(a)));
server.registerTool("startup_time", { description: "startup_time tool.", inputSchema: ToolSchemas.startupTime }, logged("startup_time", async (a: any) => H.handleStartupTime(a)));
server.registerTool("adb_parallel", { description: "adb_parallel tool.", inputSchema: ToolSchemas.adbParallel }, logged("adb_parallel", async (a: any) => H.handleAdbParallel(a)));
server.registerTool("apk_serve", { description: "apk_serve tool.", inputSchema: ToolSchemas.apkServe }, logged("apk_serve", async (a: any) => H.handleApkServe(a)));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});