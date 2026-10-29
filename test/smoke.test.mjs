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
    "android_env_check", "gradle_task", "adb_devices", "adb_screenshot",
    "adb_install", "adb_launch", "emulator_list_avds", "emulator_boot",
    "maestro_run", "compose_preview_render", "android_skills_list",
    "android_skills_search", "sdkmanager_install",
    "adb_shell", "adb_logcat", "runtime_dump",
    "frida_ps", "frida_hook", "frida_trace_methods", "net_capture",
  ]);
  assert.equal(tools.length, EXPECTED.size, "tool count drifted from 20");
  const names = new Set(tools.map((t) => t.name));
  for (const n of EXPECTED) assert.ok(names.has(n), `missing tool: ${n}`);
  console.log("smoke test passed: 20 tools");
}, 2000);
