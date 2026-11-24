// ISSUE-50: execution policy is enforced by the server boundary, not by prompt
// instructions. These tests cover mode selection, impact classification,
// exact-argument approvals, expiry, single-use replay protection, allowlists,
// alternate-wrapper bypasses and audit output.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APPROVAL_TOKEN_FIELD,
  IMPACT_CLASSES,
  baseImpact,
  createApprovalLedger,
  createExecutionPolicy,
  decodeApprovalRequest,
  encodeApprovalRequest,
  evaluateToolPolicy,
  extendSchemaWithApprovalToken,
  fingerprintRequest,
  previewOperation,
  resolveImpact,
  signApprovalRequest,
} from "../dist/executionPolicy.js";
import { TOOL_REGISTRY, handleToolCatalog } from "../dist/registry.js";
import { createWorkspacePolicy } from "../dist/workspace.js";
import { runWithBoundary } from "../dist/boundary.js";
import { runInstrumentedTool } from "../dist/outcome.js";

const SECRET = "s".repeat(32);
const OTHER_SECRET = "z".repeat(32);
const NOW = new Date("2026-05-01T12:00:00Z");
const LATER = new Date(NOW.getTime() + 301_000);

function entry(name) {
  const found = TOOL_REGISTRY.find((tool) => tool.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function execution(env = {}, instanceId = "instance-1") {
  return createExecutionPolicy({
    env: { ANDROID_MCP_APPROVAL_SECRET: SECRET, ...env },
    instanceId,
  });
}

function evaluate(name, args, policy = execution(), ledger = createApprovalLedger(), now = NOW) {
  return evaluateToolPolicy({ entry: entry(name), args, policy, ledger, now });
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "android-mcp-policy-"));
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  const workspace = createWorkspacePolicy({ root, tempRoot: join(base, "tmp"), env: {} });
  return { base, root, workspace };
}

test("the default policy is balanced with a five-minute approval window", () => {
  const policy = createExecutionPolicy({ env: {}, instanceId: "instance-default" });
  assert.equal(policy.mode, "balanced");
  assert.equal(policy.approvalSecret, null);
  assert.deepEqual(policy.allow, []);
  assert.equal(policy.approvalTtlMs, 300_000);
  assert.equal(policy.instanceId, "instance-default");
});

test("invalid policy configuration fails closed at startup", () => {
  assert.throws(
    () => createExecutionPolicy({ env: { ANDROID_MCP_POLICY: "yolo" } }),
    /ANDROID_MCP_POLICY/,
  );
  assert.throws(
    () => createExecutionPolicy({ env: { ANDROID_MCP_APPROVAL_SECRET: "too-short" } }),
    /at least 32/,
  );
  assert.throws(
    () => createExecutionPolicy({ env: { ANDROID_MCP_ALLOW: "*" } }),
    /wildcard|ANDROID_MCP_ALLOW/,
  );
  assert.throws(
    () => createExecutionPolicy({ env: { ANDROID_MCP_ALLOW: "device.shell,,bad key" } }),
    /ANDROID_MCP_ALLOW/,
  );
  assert.throws(
    () =>
      createExecutionPolicy({
        env: { ANDROID_MCP_APPROVAL_SECRET: SECRET, ANDROID_MCP_APPROVAL_TTL_SEC: "5" },
      }),
    /ANDROID_MCP_APPROVAL_TTL_SEC/,
  );
});

test("every registered tool has an explicit impact classification", () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(IMPACT_CLASSES.includes(baseImpact(tool)), `${tool.name} impact`);
  }
  assert.equal(baseImpact(entry("android_env_check")), "read-only");
  assert.equal(baseImpact(entry("apk_decompile")), "local-reversible");
  assert.equal(baseImpact(entry("adb_launch")), "device-state");
  assert.equal(baseImpact(entry("adb_shell")), "destructive");
  assert.equal(baseImpact(entry("apk_serve")), "network-exposure");
  assert.equal(baseImpact(entry("sdkmanager_install")), "external-write");
});

test("balanced mode lets read-only and reversible local work run", () => {
  for (const name of ["android_env_check", "adb_devices", "secret_scan", "adb_screenshot"]) {
    const decision = evaluate(name, {});
    assert.equal(decision.allowed, true, name);
    assert.equal(decision.meta.decision, "allowed", name);
    assert.deepEqual(decision.meta.warnings, [], name);
  }
});

test("balanced mode gates every tool that declares an approval requirement", () => {
  for (const tool of TOOL_REGISTRY) {
    const decision = evaluateToolPolicy({
      entry: tool,
      args: {},
      policy: execution(),
      ledger: createApprovalLedger(),
      now: NOW,
    });
    if (tool.approval === "none") {
      assert.equal(decision.allowed, true, `${tool.name} should run without approval`);
    } else {
      assert.equal(decision.allowed, false, `${tool.name} must be gated`);
      assert.equal(decision.reason, "approval-required", tool.name);
    }
  }
});

test("destructive minimum set cannot bypass policy through any wrapper", () => {
  for (const name of [
    "adb_shell",
    "adb_parallel",
    "adb_rm",
    "adb_uninstall",
    "adb_clear_data",
    "adb_reboot",
    "avd_delete",
    "avd_wipe",
    "emulator_snapshot",
    "sdkmanager_install",
    "gradle_task",
    "net_capture",
    "apk_serve",
  ]) {
    const decision = evaluate(name, {});
    assert.equal(decision.allowed, false, name);
    assert.equal(decision.reason, "approval-required", name);
  }
});

test("high-impact wrappers get a concrete preview instead of a generic placeholder", () => {
  const cases = [
    ["adb_rm", { remotePath: "/sdcard/private" }, "rm -rf /sdcard/private"],
    ["adb_push", { localPath: "./a.apk", remotePath: "/sdcard/a.apk" }, "push ./a.apk"],
    ["adb_force_stop", { packageName: "com.example.app" }, "am force-stop com.example.app"],
    ["adb_input", { action: "tap", x: 10, y: 20 }, "input tap 10 20"],
    ["adb_deep_link", { uri: "example://open" }, "android.intent.action.VIEW -d example://open"],
    ["adb_broadcast", { action: "com.example.PING" }, "am broadcast -a com.example.PING"],
    ["adb_service_start", { component: "com.example.app/.Sync" }, "am startservice -n"],
    ["adb_wifi", { action: "connect", host: "10.0.0.2", port: 5555 }, "connect 10.0.0.2:5555"],
    ["adb_logcat", { clear: true, tag: "MyApp:E" }, "logcat -c"],
    ["emulator_boot", { avdName: "Pixel_6" }, "emulator -avd Pixel_6"],
    ["maestro_run", { flowPath: "flows/login.yaml" }, "maestro test flows/login.yaml"],
    ["instrumented_test", { projectPath: "/work/app", module: ":app" }, "connectedAndroidTest"],
    ["layout_bounds", { enabled: true }, "setprop debug.layout true"],
  ];
  for (const [name, args, expected] of cases) {
    const preview = previewOperation(entry(name), args);
    assert.ok(preview.includes(expected), `${name}: ${preview}`);
    assert.doesNotMatch(preview, /supplied operation arguments/, name);
  }

  const inline = previewOperation(entry("frida_hook"), {
    packageName: "com.example.app",
    script: "const secret = 'do-not-print-this';",
  });
  assert.match(inline, /inline script/);
  assert.doesNotMatch(
    inline,
    /do-not-print-this/,
    "inline script bodies are not copied into previews",
  );
});

test("a blocked operation carries a preview and an encoded approval request", () => {
  const decision = evaluate("adb_shell", {
    deviceId: "emulator-5554",
    command: "rm -rf /sdcard/secret",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "approval-required");
  assert.equal(decision.meta.mode, "balanced");
  assert.equal(decision.meta.impact, "destructive");
  assert.match(decision.meta.target, /device:emulator-5554/);
  assert.match(decision.preview, /rm -rf \/sdcard\/secret/);
  assert.ok(decision.approval);
  assert.match(decision.approval.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(decision.approval.instanceId, "instance-1");
  assert.equal(decision.approval.tool, "adb_shell");
  assert.equal(decision.approval.policyKey, "device.shell");
  assert.match(decision.guidance.join("\n"), /approvalToken/);
  assert.match(decision.guidance.join("\n"), /npm run approve/);

  const decoded = decodeApprovalRequest(encodeApprovalRequest(decision.approval));
  assert.deepEqual(decoded, decision.approval);
});

test("an approval is bound to the exact tool, target and arguments", () => {
  const policy = execution();
  const ledger = createApprovalLedger();
  const args = { deviceId: "emulator-5554", command: "echo one" };
  const first = evaluate("adb_shell", args, policy, ledger);
  const token = signApprovalRequest(first.approval, SECRET);

  const ok = evaluate("adb_shell", { ...args, approvalToken: token }, policy, ledger);
  assert.equal(ok.allowed, true);
  assert.equal(ok.meta.approvalId, first.approval.id);

  const otherArgs = evaluate(
    "adb_shell",
    { ...args, command: "echo two", approvalToken: token },
    policy,
    createApprovalLedger(),
  );
  assert.equal(otherArgs.allowed, false);
  assert.equal(otherArgs.reason, "approval-mismatch");

  const otherTool = evaluate(
    "adb_parallel",
    { command: "echo one", approvalToken: token },
    policy,
    createApprovalLedger(),
  );
  assert.equal(otherTool.allowed, false);
  assert.equal(
    otherTool.reason,
    "approval-mismatch",
    "a token for adb_shell cannot authorize adb_parallel",
  );

  const otherInstance = evaluate(
    "adb_shell",
    { ...args, approvalToken: token },
    execution({}, "instance-2"),
    createApprovalLedger(),
  );
  assert.equal(otherInstance.allowed, false);
  assert.equal(otherInstance.reason, "approval-mismatch", "a token cannot survive a restart");
});

test("approvals are single-use and short-lived", () => {
  const policy = execution();
  const ledger = createApprovalLedger();
  const args = { deviceId: "emulator-5554", command: "echo once" };
  const request = evaluate("adb_shell", args, policy, ledger).approval;
  const token = signApprovalRequest(request, SECRET);

  assert.equal(
    evaluate("adb_shell", { ...args, approvalToken: token }, policy, ledger).allowed,
    true,
  );
  const replay = evaluate("adb_shell", { ...args, approvalToken: token }, policy, ledger);
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, "approval-replayed");

  const fresh = createApprovalLedger();
  const expired = evaluate(
    "adb_shell",
    {
      ...args,
      approvalToken: signApprovalRequest(
        evaluate("adb_shell", args, policy, fresh).approval,
        SECRET,
      ),
    },
    policy,
    fresh,
    LATER,
  );
  assert.equal(expired.allowed, false);
  assert.equal(expired.reason, "approval-expired");
});

test("forged or tampered tokens never authorize an operation", () => {
  const policy = execution();
  const args = { deviceId: "emulator-5554", command: "echo safe" };
  const request = evaluate("adb_shell", args, policy, createApprovalLedger()).approval;

  const foreign = signApprovalRequest(request, OTHER_SECRET);
  const foreignDecision = evaluate(
    "adb_shell",
    { ...args, approvalToken: foreign },
    policy,
    createApprovalLedger(),
  );
  assert.equal(foreignDecision.reason, "approval-invalid");

  const valid = signApprovalRequest(request, SECRET);
  const [body, signature] = valid.split(".");
  // Tamper with the first signature character. The trailing base64url character
  // carries only padding bits, so flipping it can decode to the same MAC.
  const tampered = `${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const tamperedDecision = evaluate(
    "adb_shell",
    { ...args, approvalToken: tampered },
    policy,
    createApprovalLedger(),
  );
  assert.equal(tamperedDecision.reason, "approval-invalid");

  const malformed = evaluate(
    "adb_shell",
    { ...args, approvalToken: "not-a-token" },
    policy,
    createApprovalLedger(),
  );
  assert.equal(malformed.reason, "approval-invalid");
});

test("balanced mode without an approval secret blocks gated work explicitly", () => {
  const policy = createExecutionPolicy({ env: {}, instanceId: "instance-1" });
  const decision = evaluate("adb_shell", { command: "echo safe" }, policy);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "approval-unconfigured");
  assert.equal(decision.approval, undefined);
  assert.match(decision.guidance.join("\n"), /ANDROID_MCP_APPROVAL_SECRET/);
});

test("restricted mode allows read-only tools and explicit allowlist entries only", () => {
  const restricted = execution({ ANDROID_MCP_POLICY: "restricted" });
  assert.equal(evaluate("adb_devices", {}, restricted).allowed, true);
  assert.equal(evaluate("secret_scan", {}, restricted).reason, "not-allowlisted");
  assert.equal(evaluate("adb_shell", {}, restricted).reason, "not-allowlisted");

  const byKey = execution({
    ANDROID_MCP_POLICY: "restricted",
    ANDROID_MCP_ALLOW: "device.shell",
  });
  const ledger = createApprovalLedger();
  const args = { deviceId: "emulator-5554", command: "echo allowed" };
  const request = evaluate("adb_shell", args, byKey, ledger);
  assert.equal(request.allowed, false);
  assert.equal(request.reason, "approval-required", "allowlisting does not replace approval");
  const token = signApprovalRequest(request.approval, SECRET);
  const allowed = evaluate("adb_shell", { ...args, approvalToken: token }, byKey, ledger);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.meta.mode, "restricted");

  const byName = execution({
    ANDROID_MCP_POLICY: "restricted",
    ANDROID_MCP_ALLOW: "secret_scan",
  });
  assert.equal(evaluate("secret_scan", {}, byName).allowed, true);

  const missing = execution({
    ANDROID_MCP_POLICY: "restricted",
    ANDROID_MCP_ALLOW: "device.shell",
  });
  assert.equal(evaluate("adb_rm", { remotePath: "/sdcard/x" }, missing).reason, "not-allowlisted");
  assert.match(evaluate("adb_shell", {}, restricted).guidance.join("\n"), /ANDROID_MCP_ALLOW/);
});

test("permissive mode is an explicit escape hatch with warnings", () => {
  const permissive = execution({ ANDROID_MCP_POLICY: "permissive" });
  const decision = evaluate("adb_shell", { command: "echo raw" }, permissive);
  assert.equal(decision.allowed, true);
  assert.equal(decision.meta.decision, "allowed");
  assert.ok(decision.meta.warnings.length > 0);
  assert.match(decision.meta.warnings.join(" "), /permissive/);
  assert.match(decision.meta.warnings.join(" "), /destructive/);

  const readOnly = evaluate("adb_devices", {}, permissive);
  assert.deepEqual(readOnly.meta.warnings, [], "read-only operations do not warn");
});

test("Gradle publish-like tasks are classified as production-impacting", () => {
  const gradle = entry("gradle_task");
  assert.equal(resolveImpact(gradle, { task: ":app:assembleDebug" }), "destructive");
  assert.equal(
    resolveImpact(gradle, { task: ":app:publishReleasePublicationToMavenRepository" }),
    "production",
  );
  assert.equal(resolveImpact(gradle, { task: ":app:publishToMavenLocal" }), "destructive");
  const restricted = execution({
    ANDROID_MCP_POLICY: "restricted",
    ANDROID_MCP_ALLOW: "gradle.task",
  });
  const decision = evaluate(
    "gradle_task",
    { projectPath: "/tmp/project", task: ":app:publishReleasePublicationToMavenRepository" },
    restricted,
  );
  assert.equal(decision.impact, "production");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "approval-required");
});

test("scoped Gradle tools cannot smuggle a publish task through args", () => {
  const smuggled = { projectPath: "/tmp/project", args: ["publishReleasePublicationToMavenRepository"] };
  for (const name of ["gradle_test", "gradle_lint", "build_variant", "instrumented_test", "macrobenchmark"]) {
    assert.equal(resolveImpact(entry(name), smuggled), "production", name);
  }
  const decision = evaluate("gradle_test", smuggled);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "approval-required");
  assert.match(decision.preview, /publishReleasePublicationToMavenRepository/);
});
test("fingerprints ignore key order, approval tokens and only bind real arguments", () => {
  const tool = entry("adb_shell");
  assert.equal(
    fingerprintRequest(tool, { a: 1, b: { c: 2, d: 3 } }),
    fingerprintRequest(tool, { b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(fingerprintRequest(tool, { a: 1 }), fingerprintRequest(tool, { a: 2 }));
  assert.equal(
    fingerprintRequest(tool, { command: "x", approvalToken: "token" }),
    fingerprintRequest(tool, { command: "x" }),
  );
});

test("every tool schema accepts an approvalToken field", () => {
  for (const tool of TOOL_REGISTRY) {
    const schema = extendSchemaWithApprovalToken(tool.schema);
    assert.ok(schema.shape?.[APPROVAL_TOKEN_FIELD], `${tool.name} schema`);
  }
});

test("the boundary blocks before the handler and accepts a bound token", async () => {
  const f = fixture();
  try {
    const policy = execution();
    const ledger = createApprovalLedger();
    const executionGuard = { policy, ledger };
    let calls = 0;
    let received;
    const handler = async (args) => {
      calls += 1;
      received = args;
      return { content: [{ type: "text", text: "executed" }] };
    };

    const blocked = await runWithBoundary(
      "adb_shell",
      { deviceId: "emulator-5554", command: "echo top-secret" },
      handler,
      {
        policy: f.workspace,
        execution: executionGuard.policy,
        approvals: executionGuard.ledger,
        now: () => NOW,
      },
    );
    assert.equal(calls, 0);
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /status=blocked/);
    assert.match(blocked.content[0].text, /reason=approval-required/);
    assert.match(blocked.content[0].text, /impact=destructive/);
    assert.equal(blocked._meta.provenance.trust, "mcp-policy");
    assert.equal(blocked._meta.policy.mode, "balanced");
    assert.equal(blocked._meta.approval.passAs, "approvalToken");
    assert.match(blocked._meta.approval.request, /^[A-Za-z0-9_-]+$/);

    const request = decodeApprovalRequest(blocked._meta.approval.request);
    const token = signApprovalRequest(request, SECRET);
    const allowed = await runWithBoundary(
      "adb_shell",
      { deviceId: "emulator-5554", command: "echo top-secret", approvalToken: token },
      handler,
      {
        policy: f.workspace,
        execution: executionGuard.policy,
        approvals: executionGuard.ledger,
        now: () => NOW,
      },
    );
    assert.equal(allowed.isError, false);
    assert.equal(calls, 1);
    assert.equal(received.approvalToken, undefined, "the token is stripped before the handler");
    assert.equal(received.command, "echo top-secret");
    assert.equal(allowed._meta.policy.decision, "allowed");
    assert.equal(allowed._meta.policy.approvalId, request.id);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("permissive results carry a trusted warning before untrusted payload", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await runWithBoundary(
      "adb_shell",
      { command: "echo ok" },
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "device output" }] };
      },
      {
        policy: f.workspace,
        execution: execution({ ANDROID_MCP_POLICY: "permissive" }),
        approvals: createApprovalLedger(),
        now: () => NOW,
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /^\[android-mcp:policy\]/);
    assert.match(result.content[0].text, /permissive/);
    assert.doesNotMatch(result.content[0].text, /untrusted-data/);
    assert.match(result.content[1].text, /\[android-mcp:untrusted-data/);
    assert.match(result._meta.policy.warnings[0], /permissive/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("policy decisions are audited without raw arguments or secrets", async () => {
  const f = fixture();
  const args = { deviceId: "emulator-5554", command: "echo super-secret-argument-value" };
  const lines = [];
  const logger = (line) => lines.push(line);
  let calls = 0;
  const handler = async () => {
    calls += 1;
    return { content: [{ type: "text", text: "ok" }] };
  };

  const blocked = await runInstrumentedTool({
    name: "adb_shell",
    args,
    handler,
    policy: f.workspace,
    execution: execution(),
    approvals: createApprovalLedger(),
    logger,
    now: () => 1000,
  });
  assert.equal(calls, 0);
  assert.equal(blocked.isError, true);
  const blockedEnd = lines.find((line) => line.includes("event=tool.end"));
  assert.match(blockedEnd, /outcome=blocked/);
  assert.match(blockedEnd, /policy=balanced/);
  assert.match(blockedEnd, /impact=destructive/);
  assert.match(blockedEnd, /decision=blocked/);
  assert.match(blockedEnd, /target=device:emulator-5554/);
  assert.match(blockedEnd, /policy_reason=approval-required/);
  assert.match(blockedEnd, /approval_id=[0-9a-f-]{36}/);
  for (const line of lines) assert.doesNotMatch(line, /super-secret-argument-value/);

  lines.length = 0;
  const allowed = await runInstrumentedTool({
    name: "adb_shell",
    args,
    handler,
    policy: f.workspace,
    execution: execution({ ANDROID_MCP_POLICY: "permissive" }),
    approvals: createApprovalLedger(),
    logger,
    now: () => 2000,
  });
  assert.equal(allowed.isError, false);
  assert.equal(calls, 1);
  const allowedEnd = lines.find((line) => line.includes("event=tool.end"));
  assert.match(allowedEnd, /outcome=success/);
  assert.match(allowedEnd, /policy=permissive/);
  assert.match(allowedEnd, /decision=allowed/);
  for (const line of lines) assert.doesNotMatch(line, /super-secret-argument-value/);
  rmSync(f.base, { recursive: true, force: true });
});

test("the tool catalogue exposes the impact class", async () => {
  const result = await handleToolCatalog({ category: "adb" });
  const payload = JSON.parse(result.content[0].text);
  const shell = payload.groups[0].tools.find((tool) => tool.name === "adb_shell");
  assert.equal(shell.impact, "destructive");
  assert.equal(shell.risk, "destructive");
  assert.equal(shell.approval, "expert");
});

test("the out-of-band CLI signs a blocked request end to end", async () => {
  const f = fixture();
  try {
    const policy = execution();
    const ledger = createApprovalLedger();
    const args = { deviceId: "emulator-5554", command: "echo approved once" };
    let calls = 0;
    const handler = async (received) => {
      calls += 1;
      assert.equal(received.approvalToken, undefined, "the token never reaches the handler");
      return { content: [{ type: "text", text: "executed" }], isError: false };
    };
    const boundary = { policy: f.workspace, execution: policy, approvals: ledger, now: () => NOW };

    const blocked = await runWithBoundary("adb_shell", args, handler, boundary);
    assert.equal(calls, 0);
    assert.equal(blocked.isError, true);
    assert.equal(blocked._meta.approval.passAs, APPROVAL_TOKEN_FIELD);
    const request = blocked._meta.approval.request;
    assert.match(request, /^[A-Za-z0-9_-]+$/);

    const repo = join(import.meta.dirname, "..");
    const sign = spawnSync(process.execPath, [join(repo, "scripts", "approve.mjs"), request], {
      encoding: "utf8",
      env: { ...process.env, ANDROID_MCP_APPROVAL_SECRET: SECRET },
    });
    assert.equal(sign.status, 0, sign.stderr);
    const token = sign.stdout.trim();
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const allowed = await runWithBoundary(
      "adb_shell",
      { ...args, approvalToken: token },
      handler,
      boundary,
    );
    assert.equal(allowed.isError, false, allowed.content[0].text);
    assert.equal(calls, 1);
    assert.equal(allowed._meta.policy.decision, "allowed");

    const replay = await runWithBoundary(
      "adb_shell",
      { ...args, approvalToken: token },
      handler,
      boundary,
    );
    assert.equal(replay.isError, true);
    assert.match(replay.content[0].text, /reason=approval-replayed/);
    assert.equal(calls, 1);

    const asJson = spawnSync(
      process.execPath,
      [join(repo, "scripts", "approve.mjs"), "--json", request],
      { encoding: "utf8", env: { ...process.env, ANDROID_MCP_APPROVAL_SECRET: SECRET } },
    );
    assert.equal(asJson.status, 0, asJson.stderr);
    const payload = JSON.parse(asJson.stdout);
    assert.equal(payload.passAs, APPROVAL_TOKEN_FIELD);
    assert.equal(payload.singleUse, true);
    assert.equal(payload.request.id, decodeApprovalRequest(request).id);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
