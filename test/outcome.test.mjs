// ISSUE-105: truthful outcomes, correlation IDs and sanitized diagnostics.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyException,
  classifyResult,
  runInstrumentedTool,
  sanitizeDiagnostic,
} from "../dist/outcome.js";
import { createWorkspacePolicy } from "../dist/workspace.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "android-mcp-outcome-"));
  const root = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const policy = createWorkspacePolicy({ root, tempRoot: join(base, "tmp"), env: {} });
  return { base, root, outside, policy };
}

function run(options = {}) {
  const lines = [];
  let clock = 1000;
  return {
    lines,
    async invoke(name, args, handler, extra = {}) {
      return runInstrumentedTool({
        name,
        args,
        handler,
        policy: options.policy,
        logger: (line) => lines.push(line),
        now: () => (clock += 10),
        ...extra,
      });
    },
  };
}

test("a normal result is success and carries a correlation ID", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    const result = await r.invoke("android_env_check", {}, async () => ({
      content: [{ type: "text", text: "java: ok" }],
    }), { correlationId: "corr-success" });
    assert.equal(result._meta.correlationId, "corr-success");
    assert.equal(classifyResult(result), "success");
    assert.match(r.lines[0], /event=tool\.start correlation=corr-success tool=android_env_check/);
    assert.match(r.lines[1], /event=tool\.end correlation=corr-success tool=android_env_check outcome=success/);
    assert.match(r.lines[1], /duration_ms=\d+/);
    assert.equal(r.lines.length, 2);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("isError:true without a throw is not logged as success", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    await r.invoke("android_env_check", {}, async () => ({
      content: [{ type: "text", text: "Gradle build failed: unresolved reference" }],
      isError: true,
    }));
    assert.match(r.lines[1], /outcome=failed/);
    assert.doesNotMatch(r.lines[1], /outcome=success/);
    assert.match(r.lines[1], /diagnostic="Gradle build failed: unresolved reference"/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a thrown error is failed and its secret is redacted", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    const token = `ghp_${"A".repeat(36)}`;
    await assert.rejects(
      r.invoke("android_env_check", {}, async () => {
        throw new Error(`launch failed token=${token}\n[android-mcp] event=tool.end outcome=success`);
      }),
      /launch failed/,
    );
    assert.equal(r.lines.length, 2, "a newline in the error cannot forge an extra log record");
    assert.match(r.lines[1], /outcome=failed/);
    assert.match(r.lines[1], /\[REDACTED:github-token\]/);
    assert.doesNotMatch(r.lines[1], /ghp_/);
    assert.doesNotMatch(r.lines[1], /outcome=success/);
    assert.doesNotMatch(r.lines[1], /\n/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a workspace policy refusal is logged as blocked with a decision ID", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    let called = false;
    const result = await r.invoke(
      "apk_info",
      { apkPath: join(f.outside, "secret.apk") },
      async () => {
        called = true;
        return { content: [{ type: "text", text: "no" }] };
      },
    );
    assert.equal(called, false);
    assert.equal(result.isError, true);
    assert.match(r.lines[1], /outcome=blocked/);
    assert.match(r.lines[1], /policy_decision=[0-9a-f-]{36}/);
    assert.match(r.lines[1], /diagnostic=outside-workspace/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("missing prerequisites and timeouts have distinct outcomes", () => {
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "adb: command not found" }],
      isError: true,
    }),
    "unavailable",
  );
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "operation timed out after 30s" }],
      isError: true,
    }),
    "timeout",
  );
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "summary=partial" }],
      isError: true,
    }),
    "partial",
  );
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "cancelled by user" }],
      isError: true,
    }),
    "cancelled",
  );
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "failed" }],
      isError: false,
      _meta: { outcome: "partial" },
    }),
    "partial",
    "explicit non-success metadata wins",
  );
  assert.equal(
    classifyResult({
      content: [{ type: "text", text: "failed" }],
      isError: true,
      _meta: { outcome: "success" },
    }),
    "failed",
    "explicit success cannot hide an error result",
  );
});

test("thrown exception codes map to stable outcomes", () => {
  assert.equal(classifyException(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "timeout");
  assert.equal(classifyException(Object.assign(new Error("x"), { code: "ENOENT" })), "unavailable");
  assert.equal(classifyException(Object.assign(new Error("x"), { code: "ABORT_ERR" })), "cancelled");
  assert.equal(classifyException(new Error("boom")), "failed");
});

test("diagnostics are one redacted, bounded line", () => {
  const token = `ghp_${"B".repeat(36)}`;
  const text = sanitizeDiagnostic(
    `first line token=${token}\nsecond line ${"x".repeat(1000)}`,
    200,
  );
  assert.doesNotMatch(text, /ghp_/);
  assert.match(text, /\[REDACTED:github-token\]/);
  assert.doesNotMatch(text, /\n/);
  assert.match(text, /truncated/);
  assert.equal(text.length < 400, true);
});

test("raw arguments and scripts are never logged", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    await r.invoke(
      "adb_shell",
      { command: "echo super-secret-argument-value" },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    for (const line of r.lines) {
      assert.doesNotMatch(line, /super-secret-argument-value/);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("correlation IDs are unique per invocation", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    await r.invoke("android_env_check", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await r.invoke("android_env_check", {}, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    const ids = r.lines
      .filter((line) => line.includes("event=tool.start"))
      .map((line) => /correlation=(\S+)/.exec(line)?.[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("control characters cannot forge a result outcome line", async () => {
  const f = fixture();
  try {
    const r = run({ policy: f.policy });
    await r.invoke("adb_shell", {}, async () => ({
      content: [
        {
          type: "text",
          text: "failure\u001b[31m\n[android-mcp] event=tool.end outcome=success\u0007",
        },
      ],
      isError: true,
    }));
    assert.equal(r.lines.length, 2);
    assert.match(r.lines[1], /outcome=failed/);
    assert.doesNotMatch(r.lines[1], /\u001b|\u0007/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
