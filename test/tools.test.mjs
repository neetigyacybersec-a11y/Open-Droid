// Output-cap tests for the adb handlers (requires `npm run build` first, like smoke.test.mjs).
// The handlers are exercised end to end through a stub `adb` on PATH, so the assertion
// covers the emitted tool text rather than only the helper.
import { strict as assert } from "node:assert";
import { test, skip } from "node:test";
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capOutput,
  handleAdbShell,
  handleRuntimeDump,
  handleApkServe,
  handleApkDecompile,
  handleAdbRm,
  handleAdbDeepLink,
  handleAdbBroadcast,
  handleComposeRecomposition,
  handleAvdCreate,
  handleApkInfo,
} from "../dist/tools.js";
import { validateGradleTask } from "../dist/util.js";

// The stubs below are POSIX shell scripts driven by `realpath`/`execFile` with a
// `/bin/sh`-style stub on PATH; Windows cannot execute them (no shell shebangs,
// libuv refuses to spawn `.bat` without `shell:`), so on win32 they are
// reported as skipped and full coverage is provided by the Linux CI job.
const stubbedTests =
  process.platform === "win32" ? (name, fn) => skip(name, fn) : (name, fn) => test(name, fn);

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

stubbedTests("runtime_dump marks truncated stdout instead of dropping it silently", async () => {
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

stubbedTests("runtime_dump adds no marker for output under the cap", async () => {
  await withStubAdb("printf 'some dumpsys text'", async () => {
    const out = text(await handleRuntimeDump({ kind: "service" }));
    assert.match(out, /--- stdout ---\nsome dumpsys text\n--- stderr ---/);
    assert.doesNotMatch(out, MARKER_RE);
  });
});

stubbedTests("adb_shell uses the same cap and marker", async () => {
  await withStubAdb("i=0; while [ $i -lt 40001 ]; do printf B; i=$((i+1)); done", async () => {
    const out = text(await handleAdbShell({ command: "cat big" }));
    const stdout = out.split("--- stdout ---\n")[1].split("\n--- stderr ---\n")[0];
    assert.equal(stdout.slice(0, MAX).length, MAX);
    assert.match(stdout.split("\n").pop(), MARKER_RE);
    assert.match(stdout.split("\n").pop(), /40001/);
  });
});

// ---------------------------------------------------------------------------
// Security hardening regressions (GitHub issues 65, 66, 67, 68, 69).
// Stubs record their argv and would execute a marker command if any shell
// interpolation or second command reached them; assertions prove it cannot.
// ---------------------------------------------------------------------------

// Generic multi-binary stubber: name -> shell script body. Records each
// invocation's argv one line per call into $RECORD (set via process.env).
async function withStubs(stubs, fn) {
  const dir = await mkdtemp(join(tmpdir(), "android-mcp-sec-test-"));
  for (const [name, body] of Object.entries(stubs)) {
    const bin = join(dir, name);
    await writeFile(bin, `#!/bin/sh\n${body}\n`);
    await chmod(bin, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
}

const RECORD = () => join(tmpdir(), `android-mcp-record-${process.pid}-${Math.random().toString(36).slice(2)}`);
const readRecord = async (p) => (await readFile(p, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
// one arg per line (newline-separated so embedded spaces/quotes survive)
const APPEND_ARGS = 'printf \'%s\\n\' "$@" >> "$RECORD"';

stubbedTests("apk_serve start: localhost bind by default, no shell in APK discovery (issues 65, 66)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const marker = join(work, "marker");
  const state = join(work, "serve-state.json");
  const record = RECORD();
  const payloadDir = `${work}/x"; touch ${marker}; #`;
  const realDir = join(work, "serve");
  await mkdir(realDir, { recursive: true });
  process.env.RECORD = record;
  process.env.MARKER = marker;
  process.env.ANDROID_MCP_SERVE_STATE = state;
  try {
    await withStubs({ python3: APPEND_ARGS }, async () => {
      // crafted dir payload: discovery must not run a shell command derived from dir
      await handleApkServe({ action: "start", dir: payloadDir, port: 18099 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await readFile(marker, "utf8").then(() => true).catch(() => false)), false, "a marker command executed — shell interpolation in APK discovery");
      // then a legitimate start: python3 must bind to loopback only
      await handleApkServe({ action: "start", dir: realDir, port: 18099 });
      await new Promise((r) => setTimeout(r, 300));
      const pyArgs = await readRecord(record);
      assert.ok(pyArgs.length > 0, "python3 (http.server) was not invoked");
      assert.ok(pyArgs.includes("--bind"), "http.server must be started with an explicit --bind");
      assert.ok(pyArgs.includes("127.0.0.1"), "default bind must be 127.0.0.1");
      assert.ok(!pyArgs.includes("0.0.0.0"), "default bind must not be 0.0.0.0");
    });
  } finally {
    await handleApkServe({ action: "stop" }).catch(() => {});
    delete process.env.RECORD;
    delete process.env.MARKER;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("apk_serve start: LAN exposure requires explicit opt-in (issue 66)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const record = RECORD();
  process.env.RECORD = record;
  process.env.ANDROID_MCP_SERVE_STATE = join(work, "serve-state.json");
  try {
    await withStubs({ python3: APPEND_ARGS }, async () => {
      await handleApkServe({ action: "start", dir: work, port: 18099, expose: true });
      await new Promise((r) => setTimeout(r, 300));
      const pyArgs = await readRecord(record);
      assert.ok(pyArgs.includes("--bind"), "http.server must be started with an explicit --bind");
      assert.ok(pyArgs.includes("0.0.0.0"), "expose:true must opt in to a 0.0.0.0 bind");
    });
  } finally {
    await handleApkServe({ action: "stop" }).catch(() => {});
    delete process.env.RECORD;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("apk_serve start twice kills the first listener (issue 66)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const record = RECORD();
  process.env.RECORD = record;
  process.env.ANDROID_MCP_SERVE_STATE = join(work, "serve-state.json");
  try {
    // sleeper stub so the first server stays alive until the second start kills it
    await withStubs({ python3: `${APPEND_ARGS}; sleep 5` }, async () => {
      await handleApkServe({ action: "start", dir: work, port: 18099 });
      const state = JSON.parse(await readFile(process.env.ANDROID_MCP_SERVE_STATE, "utf8"));
      const firstPid = state.pid;
      assert.ok(firstPid, "state file must record the server pid");
      await new Promise((r) => setTimeout(r, 200));
      await handleApkServe({ action: "start", dir: work, port: 18099 });
      // the first listener must be gone, not orphaned (allow SIGTERM a moment)
      let alive = true;
      for (let i = 0; i < 20; i++) {
        try { process.kill(firstPid, 0); } catch { alive = false; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(alive, false, "repeated start orphaned the first listener");
    });
  } finally {
    await handleApkServe({ action: "stop" }).catch(() => {});
    delete process.env.RECORD;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("apk_decompile refuses to overwrite an existing output dir; default dirs are unique (issue 69)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-decomp-work-"));
  const record = RECORD();
  const outDir = join(work, "existing-out");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "keep.txt"), "sentinel");
  process.env.RECORD = record;
  try {
    await withStubs({ jadx: APPEND_ARGS, apktool: APPEND_ARGS }, async () => {
      // existing dir without explicit opt-in: refuse, do not invoke the tool
      const res = await handleApkDecompile({ apkPath: `${work}/fake.apk`, outputDir: outDir });
      assert.equal(res.isError, true, "must refuse to reuse an existing output dir without opt-in");
      assert.equal(await readFile(join(outDir, "keep.txt"), "utf8"), "sentinel", "sentinel in existing output dir was disturbed");
      assert.equal((await readRecord(record)).length, 0, "decompiler was invoked despite the refusal");
      // opt-in works
      const ok = await handleApkDecompile({ apkPath: `${work}/fake.apk`, outputDir: outDir, overwrite: true });
      assert.equal(ok.isError, false, "overwrite:true must be honored");
      assert.ok((await readRecord(record)).length > 0, "decompiler was not invoked despite explicit opt-in");
      // default outputs are unique across calls
      const a = text(await handleApkDecompile({ apkPath: `${work}/fake.apk` }));
      const b = text(await handleApkDecompile({ apkPath: `${work}/fake.apk` }));
      const outA = /out=(\S+)/.exec(a)?.[1];
      const outB = /out=(\S+)/.exec(b)?.[1];
      assert.ok(outA && outB, "both default calls must report an output dir");
      assert.notEqual(outA, outB, "default output dirs must not collide");
      assert.doesNotMatch(outA, /^\/tmp\/decompiled-\d+$/, "default output must not be a bare timestamp name");
    });
  } finally {
    delete process.env.RECORD;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("adb shell values are remote-shell quoted and destructive paths are scoped (issue 67)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-adbq-work-"));
  const record = RECORD();
  process.env.RECORD = record;
  try {
    await withStubs({ adb: APPEND_ARGS }, async () => {
      // rm: valid in-scope path with spaces arrives as ONE remote-shell-quoted arg
      const rmRes = await handleAdbRm({ remotePath: "/sdcard/hello world dir/x.apk" });
      assert.equal(rmRes.isError, false);
      const rmArgs = await readRecord(record);
      assert.ok(rmArgs.some((a) => a === "'/sdcard/hello world dir/x.apk'"), `remote path must be single-quoted, got: ${rmArgs.join(" | ")}`);
      // rm: out-of-scope path is rejected
      await rm(record).catch(() => {});
      const badScope = await handleAdbRm({ remotePath: "/etc/passwd" });
      assert.equal(badScope.isError, true, "out-of-scope rm must be rejected");
      // rm: metacharacter payload is rejected
      const badMeta = await handleAdbRm({ remotePath: "/sdcard/x; touch /tmp/pwned" });
      assert.equal(badMeta.isError, true, "metacharacter payload in rm path must be rejected");
      // deep link: full URI (with &) arrives quoted as a single remote arg
      await rm(record).catch(() => {});
      const dlRes = await handleAdbDeepLink({ uri: "https://example.com/?a=1&b=2" });
      assert.equal(dlRes.isError, false);
      const dlArgs = await readRecord(record);
      assert.ok(dlArgs.some((a) => a === "'https://example.com/?a=1&b=2'"), `deep link URI must be quoted and intact, got: ${dlArgs.join(" | ")}`);
      // broadcast: malicious action is rejected
      await rm(record).catch(() => {});
      const bcRes = await handleAdbBroadcast({ action: "com.x.Y; rm -rf /", extras: [] });
      assert.equal(bcRes.isError, true, "malicious broadcast action must be rejected");
      // dumpsys activity: package validation applies when provided
      await rm(record).catch(() => {});
      const coRes = await handleComposeRecomposition({ kind: "activity", packageName: "pkg; id" });
      assert.equal(coRes.isError, true, "invalid package name in dumpsys must be rejected");
    });
  } finally {
    delete process.env.RECORD;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("option-like values are rejected for gradle tasks, avd names and apk paths (issue 68)", async () => {
  // task name validation
  assert.equal(validateGradleTask("-Ievil.gradle"), false, "gradle task must not accept option-like strings");
  assert.equal(validateGradleTask(":app:assembleDebug"), true, "legit task paths must keep working");
  assert.equal(validateGradleTask("assembleDebug"), true);
  const work = await mkdtemp(join(tmpdir(), "android-mcp-opt-work-"));
  const record = RECORD();
  process.env.RECORD = record;
  try {
    await withStubs({ avdmanager: APPEND_ARGS, aapt2: APPEND_ARGS }, async () => {
      // avd name: option-like value rejected without invoking the tool
      const avd = await handleAvdCreate({ avdName: "-Ievil", systemImage: "system-images;android-35;default;x86_64", device: "pixel" });
      assert.equal(avd.isError, true, "option-like avd name must be rejected");
      assert.equal((await readRecord(record)).length, 0, "avdmanager was invoked with an option-like name");
      // apk path: option-like value rejected
      const apk = await handleApkInfo({ apkPath: "-Ievil.apk" });
      assert.equal(apk.isError, true, "option-like apk path must be rejected");
      assert.equal((await readRecord(record)).length, 0, "aapt2 was invoked with an option-like path");
    });
  } finally {
    delete process.env.RECORD;
    await rm(work, { recursive: true, force: true });
  }
});
