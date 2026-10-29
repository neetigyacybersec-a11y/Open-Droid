// Output-cap tests for the adb handlers (requires `npm run build` first, like smoke.test.mjs).
// The handlers are exercised end to end through a stub `adb` on PATH, so the assertion
// covers the emitted tool text rather than only the helper.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capOutput, handleAdbShell, handleRuntimeDump } from "../dist/tools.js";

const MAX = 40_000;
const MARKER_RE = /^\[truncated: (\d+) chars total\]$/m;

async function withStubAdb(script, fn) {
  const dir = await mkdtemp(join(tmpdir(), "android-mcp-tools-test-"));
  const bin = join(dir, "adb");
  await writeFile(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
}

const text = (res) => res.content.map((c) => c.text).join("\n");

test("capOutput leaves output at or under the cap untouched", () => {
  assert.equal(capOutput(""), "");
  assert.equal(capOutput("short"), "short");
  assert.equal(capOutput("x".repeat(MAX)), "x".repeat(MAX));
  assert.doesNotMatch(capOutput("x".repeat(MAX)), MARKER_RE);
});

test("capOutput keeps the head and reports the original size", () => {
  const full = "y".repeat(MAX + 5);
  const capped = capOutput(full);
  const [body, marker] = [capped.slice(0, MAX), capped.split("\n").pop()];
  assert.equal(body, "y".repeat(MAX));
  assert.match(marker, MARKER_RE);
  assert.equal(Number(marker.match(MARKER_RE)[1]), full.length);
});

test("runtime_dump marks truncated stdout instead of dropping it silently", async () => {
  await withStubAdb("i=0; while [ $i -lt 50000 ]; do printf A; i=$((i+1)); done", async () => {
    const res = await handleRuntimeDump({ kind: "activity" });
    const out = text(res);
    const stdout = out.split("--- stdout ---\n")[1].split("\n--- stderr ---\n")[0];
    const [body, marker] = [stdout.slice(0, MAX), stdout.split("\n").pop()];
    assert.equal(body.length, MAX);
    assert.equal((body.match(/A/g) ?? []).length, MAX);
    assert.match(marker, MARKER_RE);
    assert.equal(Number(marker.match(MARKER_RE)[1]), 50_000);
    assert.match(out, /^cmd=adb shell dumpsys activity$/m);
    assert.match(out, /^exit=0$/m);
    assert.equal(res.isError, false);
  });
});

test("runtime_dump adds no marker for output under the cap", async () => {
  await withStubAdb("printf 'some dumpsys text'", async () => {
    const out = text(await handleRuntimeDump({ kind: "service" }));
    assert.match(out, /--- stdout ---\nsome dumpsys text\n--- stderr ---/);
    assert.doesNotMatch(out, MARKER_RE);
  });
});

test("adb_shell uses the same cap and marker", async () => {
  await withStubAdb("i=0; while [ $i -lt 40001 ]; do printf B; i=$((i+1)); done", async () => {
    const out = text(await handleAdbShell({ command: "cat big" }));
    const stdout = out.split("--- stdout ---\n")[1].split("\n--- stderr ---\n")[0];
    assert.equal(stdout.slice(0, MAX).length, MAX);
    assert.match(stdout.split("\n").pop(), MARKER_RE);
    assert.match(stdout.split("\n").pop(), /40001/);
  });
});
