import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";

const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
let out = "";
proc.stdout.on("data", (d) => { out += d.toString(); });

const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
proc.stdin.write(init + "\n");
proc.stdin.write(list + "\n");

setTimeout(() => {
  proc.kill();
  const lines = out.trim().split("\n").map((l) => JSON.parse(l));
  const tools = lines.find((l) => l.id === 2)?.result?.tools;
  const EXPECTED = new Set([
    "adb_battery",
    "adb_broadcast",
    "adb_clear_data",
    "adb_deep_link",
    "adb_devices",
    "adb_force_stop",
    "adb_input",
    "adb_install",
    "adb_launch",
    "adb_logcat",
    "adb_parallel",
    "adb_pull",
    "adb_push",
    "adb_reboot",
    "adb_rm",
    "adb_screenrecord",
    "adb_screenshot",
    "adb_service_start",
    "adb_shell",
    "adb_uninstall",
    "adb_wifi",
    "android_env_check",
    "android_skills_list",
    "android_skills_search",
    "anr_check",
    "apk_decompile",
    "apk_info",
    "apk_serve",
    "avd_create",
    "avd_delete",
    "avd_wipe",
    "baseline_profile_generate",
    "build_variant",
    "compose_preview_render",
    "compose_recomposition",
    "crash_summary",
    "dex_strings",
    "emulator_boot",
    "emulator_list_avds",
    "emulator_snapshot",
    "frida_hook",
    "frida_ps",
    "frida_trace_methods",
    "gradle_dependencies",
    "gradle_lint",
    "gradle_task",
    "gradle_test",
    "instrumented_test",
    "layout_bounds",
    "logcat_filtered",
    "macrobenchmark",
    "maestro_run",
    "manifest_inspect",
    "memory_profile",
    "native_libs",
    "net_capture",
    "perfetto_trace",
    "runtime_dump",
    "sdkmanager_install",
    "startup_time",
    "test_coverage",
    "ui_dump",
  ]);
  assert.equal(tools.length, EXPECTED.size, "tool count drifted");
  const got = new Set(tools.map((t) => t.name));
  for (const n of EXPECTED) assert.ok(got.has(n), `missing tool: ${n}`);
  console.log("smoke test passed:", tools.length, "tools");
}, 2000);
