import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_NAMES } from "../dist/registry.js";
import { decodeApprovalRequest, signApprovalRequest } from "../dist/executionPolicy.js";

const secret = "s".repeat(32);
const work = mkdtempSync(join(tmpdir(), "android-mcp-smoke-"));
const proc = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANDROID_MCP_WORKSPACE: work,
    ANDROID_MCP_POLICY: "balanced",
    ANDROID_MCP_APPROVAL_SECRET: secret,
    ANDROID_MCP_CHECKPOINTS_DIR: join(work, "checkpoints"),
  },
});
let buffer = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response to request ${id}`)), 10_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
const textOf = (message) => message?.result?.content?.[0]?.text ?? "";

try {
  await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  const listResponse = await request(2, "tools/list", {});
  const tools = listResponse?.result?.tools;
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
    "adb_window_geometry",
    "android_env_check",
    "android_energy_network_audit",
    "android_flaky_test_history",
    "android_project_inspect",
    "android_release_notes_generate",
    "android_skills_list",
    "android_project_checkpoint",
    "android_skills_search",
    "android_test_failure_analyze",
    "android_test_failure_bundle",
    "android_test_suite_run",
    "android_test_plan",
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
    "policy_preflight",
    "privacy_scan",
    "secret_scan",
    "security_audit",
    "runtime_dump",
    "screenshot_baseline_list",
    "screenshot_baseline_save",
    "sdkmanager_install",
    "startup_time",
    "test_coverage",
    "tool_catalog",
    "ui_dump",
  ]);
  assert.deepEqual(
    [...EXPECTED].sort(),
    [...TOOL_NAMES].sort(),
    "smoke list drifted from the typed registry",
  );
  assert.equal(tools.length, EXPECTED.size, "tool count drifted");
  const got = new Set(tools.map((t) => t.name));
  for (const n of EXPECTED) assert.ok(got.has(n), `missing tool: ${n}`);

  // ISSUE-139: exercise the real stdio tools/call path, including the approval
  // gate, _meta token merge, success and single-use replay rejection.
  const callArgs = { action: "list" };
  const blocked = await request(3, "tools/call", {
    name: "android_project_checkpoint",
    arguments: callArgs,
  });
  assert.match(textOf(blocked), /status=blocked/);
  assert.match(textOf(blocked), /approval-required/);
  const encoded = /approval-request=(\S+)/.exec(textOf(blocked))?.[1];
  assert.ok(encoded, "blocked result carries a bound approval request");
  const approval = decodeApprovalRequest(encoded);
  assert.equal(approval.tool, "android_project_checkpoint");
  const token = signApprovalRequest(approval, secret);

  const allowed = await request(4, "tools/call", {
    name: "android_project_checkpoint",
    arguments: callArgs,
    _meta: { approvalToken: token },
  });
  assert.match(textOf(allowed), /"status":\s*"ok"/);
  assert.doesNotMatch(textOf(allowed), /approval-required/);
  assert.ok(allowed.result?._meta?.provenance, "allowed result carries provenance");

  const replay = await request(5, "tools/call", {
    name: "android_project_checkpoint",
    arguments: callArgs,
    _meta: { approvalToken: token },
  });
  assert.match(textOf(replay), /status=blocked/);
  assert.match(textOf(replay), /approval-replayed/);

  console.log("smoke test passed:", tools.length, "tools; approval flow verified");
} finally {
  proc.kill();
  rmSync(work, { recursive: true, force: true });
}
