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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});