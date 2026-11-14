// Output-cap tests for the adb handlers (requires `npm run build` first, like smoke.test.mjs).
// The handlers are exercised end to end through a stub `adb` on PATH, so the assertion
// covers the emitted tool text rather than only the helper.
import { strict as assert } from "node:assert";
import { test, skip } from "node:test";
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import {
  capOutput,
  handleAdbShell,
  handleRuntimeDump,
  handleApkServe,
  handleApkDecompile,
  handleAdbRm,
  handleAdbReboot,
  handleAdbScreenshot,
  handleCrashSummary,
  handleStartupTime,
  handleBuildVariant,
  handleAvdWipe,
  handleEmulatorBoot,
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

const RECORD = () =>
  join(tmpdir(), `android-mcp-record-${process.pid}-${Math.random().toString(36).slice(2)}`);
const readRecord = async (p) =>
  (await readFile(p, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
// one arg per line (newline-separated so embedded spaces/quotes survive)
const APPEND_ARGS = 'printf \'%s\\n\' "$@" >> "$RECORD"';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A python3 stub that behaves like `http.server`: parse the real argv shape and
// serve a trivial 200 until it is terminated. Its command line keeps the
// `http.server` marker so the apk_serve ownership check can verify it.
async function httpServerStub(work) {
  const js = join(work, "http.server.js");
  await writeFile(
    js,
    'const http=require("http");const [port,bind]=process.argv.slice(2);' +
      'http.createServer((req,res)=>{res.statusCode=200;res.end("ok");}).listen(Number(port),bind);',
  );
  return [
    'printf \'%s\\n\' "$@" >> "$RECORD"',
    'port=""; bind="127.0.0.1"',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    -m) shift ;;",
    "    http.server) shift ;;",
    "    --directory) shift 2 ;;",
    '    --bind) bind="$2"; shift 2 ;;',
    '    *) port="$1"; shift ;;',
    "  esac",
    "done",
    `exec node "${js}" "$port" "$bind"`,
  ].join("\n");
}

async function waitForPidGone(pid, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function portResponds(port, timeoutMs = 500) {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

stubbedTests(
  "apk_serve start: localhost bind by default, no shell in APK discovery (issues 65, 66)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
    const marker = join(work, "marker");
    const state = join(work, "serve-state.json");
    const record = RECORD();
    const port = await freePort();
    const payloadDir = `${work}/x"; touch ${marker}; #`;
    const realDir = join(work, "serve");
    await mkdir(realDir, { recursive: true });
    process.env.RECORD = record;
    process.env.MARKER = marker;
    process.env.ANDROID_MCP_SERVE_STATE = state;
    try {
      await withStubs({ python3: await httpServerStub(work) }, async () => {
        // crafted dir payload: discovery must not run a shell command derived from dir
        const rejected = await handleApkServe({ action: "start", dir: payloadDir, port });
        assert.equal(rejected.isError, true, "a nonexistent served directory must fail");
        assert.equal(
          await readFile(marker, "utf8")
            .then(() => true)
            .catch(() => false),
          false,
          "a marker command executed — shell interpolation in APK discovery",
        );
        // then a legitimate start: python3 must bind to loopback only
        const started = await handleApkServe({ action: "start", dir: realDir, port });
        assert.equal(started.isError, false, text(started));
        assert.ok(await portResponds(port), "start must not return before the server responds");
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
  },
);

stubbedTests("apk_serve start: LAN exposure requires explicit opt-in (issue 66)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const record = RECORD();
  const port = await freePort();
  process.env.RECORD = record;
  process.env.ANDROID_MCP_SERVE_STATE = join(work, "serve-state.json");
  try {
    await withStubs({ python3: await httpServerStub(work) }, async () => {
      const started = await handleApkServe({ action: "start", dir: work, port, expose: true });
      assert.equal(started.isError, false, text(started));
      assert.match(text(started), /0\.0\.0\.0/, "expose:true must opt in to a 0.0.0.0 bind");
      assert.ok(await portResponds(port), "start must not return before the server responds");
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

stubbedTests("apk_serve start twice stops the first listener (issue 66)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const record = RECORD();
  const port = await freePort();
  process.env.RECORD = record;
  process.env.ANDROID_MCP_SERVE_STATE = join(work, "serve-state.json");
  try {
    await withStubs({ python3: await httpServerStub(work) }, async () => {
      const first = await handleApkServe({ action: "start", dir: work, port });
      assert.equal(first.isError, false, text(first));
      const state = JSON.parse(await readFile(process.env.ANDROID_MCP_SERVE_STATE, "utf8"));
      const firstPid = state.pid;
      assert.ok(firstPid, "state file must record the server pid");
      const second = await handleApkServe({ action: "start", dir: work, port });
      assert.equal(second.isError, false, text(second));
      assert.equal(
        await waitForPidGone(firstPid),
        true,
        "repeated start orphaned the first listener",
      );
    });
  } finally {
    await handleApkServe({ action: "stop" }).catch(() => {});
    delete process.env.RECORD;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests(
  "apk_decompile refuses to overwrite an existing output dir; default dirs are unique (issue 69)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-decomp-work-"));
    const record = RECORD();
    const outDir = join(work, "existing-out");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "keep.txt"), "sentinel");
    await writeFile(join(work, "fake.apk"), "PK\u0003\u0004");
    process.env.RECORD = record;
    try {
      await withStubs({ jadx: APPEND_ARGS, apktool: APPEND_ARGS }, async () => {
        // existing dir without explicit opt-in: refuse, do not invoke the tool
        const res = await handleApkDecompile({ apkPath: `${work}/fake.apk`, outputDir: outDir });
        assert.equal(
          res.isError,
          true,
          "must refuse to reuse an existing output dir without opt-in",
        );
        assert.equal(
          await readFile(join(outDir, "keep.txt"), "utf8"),
          "sentinel",
          "sentinel in existing output dir was disturbed",
        );
        assert.equal(
          (await readRecord(record)).length,
          0,
          "decompiler was invoked despite the refusal",
        );
        // opt-in works
        const ok = await handleApkDecompile({
          apkPath: `${work}/fake.apk`,
          outputDir: outDir,
          overwrite: true,
        });
        assert.equal(ok.isError, false, "overwrite:true must be honored");
        assert.ok(
          (await readRecord(record)).length > 0,
          "decompiler was not invoked despite explicit opt-in",
        );
        // default outputs are unique across calls
        const a = text(await handleApkDecompile({ apkPath: `${work}/fake.apk` }));
        const b = text(await handleApkDecompile({ apkPath: `${work}/fake.apk` }));
        const outA = /out=(\S+)/.exec(a)?.[1];
        const outB = /out=(\S+)/.exec(b)?.[1];
        assert.ok(outA && outB, "both default calls must report an output dir");
        assert.notEqual(outA, outB, "default output dirs must not collide");
        assert.doesNotMatch(
          outA,
          /^\/tmp\/decompiled-\d+$/,
          "default output must not be a bare timestamp name",
        );
      });
    } finally {
      delete process.env.RECORD;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "adb shell values are remote-shell quoted and destructive paths are scoped (issue 67)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-adbq-work-"));
    const record = RECORD();
    process.env.RECORD = record;
    try {
      await withStubs({ adb: APPEND_ARGS }, async () => {
        // rm: valid in-scope path with spaces arrives as ONE remote-shell-quoted arg
        const rmRes = await handleAdbRm({ remotePath: "/sdcard/hello world dir/x.apk" });
        assert.equal(rmRes.isError, false);
        const rmArgs = await readRecord(record);
        assert.ok(
          rmArgs.some((a) => a === "'/sdcard/hello world dir/x.apk'"),
          `remote path must be single-quoted, got: ${rmArgs.join(" | ")}`,
        );
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
        assert.ok(
          dlArgs.some((a) => a === "'https://example.com/?a=1&b=2'"),
          `deep link URI must be quoted and intact, got: ${dlArgs.join(" | ")}`,
        );
        // broadcast: malicious action is rejected
        await rm(record).catch(() => {});
        const bcRes = await handleAdbBroadcast({ action: "com.x.Y; rm -rf /", extras: [] });
        assert.equal(bcRes.isError, true, "malicious broadcast action must be rejected");
        // dumpsys activity: package validation applies when provided
        await rm(record).catch(() => {});
        const coRes = await handleComposeRecomposition({
          kind: "activity",
          packageName: "pkg; id",
        });
        assert.equal(coRes.isError, true, "invalid package name in dumpsys must be rejected");
      });
    } finally {
      delete process.env.RECORD;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "option-like values are rejected for gradle tasks, avd names and apk paths (issue 68)",
  async () => {
    // task name validation
    assert.equal(
      validateGradleTask("-Ievil.gradle"),
      false,
      "gradle task must not accept option-like strings",
    );
    assert.equal(
      validateGradleTask(":app:assembleDebug"),
      true,
      "legit task paths must keep working",
    );
    assert.equal(validateGradleTask("assembleDebug"), true);
    const work = await mkdtemp(join(tmpdir(), "android-mcp-opt-work-"));
    const record = RECORD();
    process.env.RECORD = record;
    try {
      await withStubs({ avdmanager: APPEND_ARGS, aapt2: APPEND_ARGS }, async () => {
        // avd name: option-like value rejected without invoking the tool
        const avd = await handleAvdCreate({
          avdName: "-Ievil",
          systemImage: "system-images;android-35;default;x86_64",
          device: "pixel",
        });
        assert.equal(avd.isError, true, "option-like avd name must be rejected");
        assert.equal(
          (await readRecord(record)).length,
          0,
          "avdmanager was invoked with an option-like name",
        );
        // apk path: option-like value rejected
        const apk = await handleApkInfo({ apkPath: "-Ievil.apk" });
        assert.equal(apk.isError, true, "option-like apk path must be rejected");
        assert.equal(
          (await readRecord(record)).length,
          0,
          "aapt2 was invoked with an option-like path",
        );
      });
    } finally {
      delete process.env.RECORD;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests("adb_reboot reports success only when adb exits 0 (issue 90)", async () => {
  const record = RECORD();
  process.env.RECORD = record;
  try {
    await withStubs({ adb: `${APPEND_ARGS}; exit 0` }, async () => {
      const ok = await handleAdbReboot({ deviceId: "emulator-5554" });
      assert.equal(ok.isError, false);
      assert.match(text(ok), /rebooting/i);
      assert.deepEqual(await readRecord(record), ["-s", "emulator-5554", "reboot"]);
    });
    await withStubs({ adb: "printf 'error: no devices/emulators found' >&2; exit 1" }, async () => {
      const failed = await handleAdbReboot({});
      assert.equal(failed.isError, true, "a failed adb reboot must be an error");
      assert.match(text(failed), /no devices\/emulators found/);
    });
  } finally {
    delete process.env.RECORD;
  }
});

stubbedTests("apk_decompile passes JADX its real CLI contract (issue 78)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-jadx-"));
  const record = RECORD();
  const apk = join(work, "sample app.apk");
  const outDir = join(work, "decompiled output");
  await writeFile(apk, "PK\u0003\u0004");
  process.env.RECORD = record;
  try {
    await withStubs({ jadx: APPEND_ARGS, apktool: APPEND_ARGS }, async () => {
      const ok = await handleApkDecompile({ apkPath: apk, outputDir: outDir });
      assert.equal(ok.isError, false);
      const args = await readRecord(record);
      assert.deepEqual(
        args,
        ["-d", outDir, apk],
        "JADX must receive -d <out> <apk> as separate argv values",
      );
      assert.ok(!args.includes("-o"), "JADX must not receive apktool's -o flag");

      await rm(record).catch(() => {});
      const apktool = await handleApkDecompile({
        apkPath: apk,
        outputDir: outDir,
        tool: "apktool",
        overwrite: true,
      });
      assert.equal(apktool.isError, false);
      assert.deepEqual(await readRecord(record), ["d", apk, "-o", outDir, "-f"]);

      await rm(record).catch(() => {});
      const missing = await handleApkDecompile({ apkPath: join(work, "missing.apk") });
      assert.equal(
        missing.isError,
        true,
        "a missing input APK must fail before invoking the decompiler",
      );
      assert.match(text(missing), /missing|not found|readable/i);
      assert.equal(
        (await readRecord(record)).length,
        0,
        "the decompiler was invoked for a missing APK",
      );

      await writeFile(record, "", "utf8");
      await withStubs({ jadx: "printf 'boom' >&2; exit 3" }, async () => {
        const failed = await handleApkDecompile({ apkPath: apk });
        assert.equal(failed.isError, true);
        assert.match(text(failed), /boom/);
      });
    });
  } finally {
    delete process.env.RECORD;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests(
  "adb_screenshot never advertises a deleted path and uses unique remote names (issue 84)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-shot-"));
    const record = RECORD();
    process.env.RECORD = record;
    const stub = [
      'if [ "$1" = "shell" ] && [ "$2" = "screencap" ]; then printf "%s\\n" "$4" >> "$RECORD"; exit "${SCREENCAP_FAIL:-0}"; fi',
      'if [ "$1" = "pull" ]; then printf "PNGDATA" > "$3"; exit "${PULL_FAIL:-0}"; fi',
      'if [ "$1" = "shell" ] && [ "$2" = "rm" ]; then printf "rm:%s\\n" "$4" >> "$RECORD"; exit 0; fi',
      "exit 0",
    ].join("\n");
    try {
      await withStubs({ adb: stub }, async () => {
        const transient = await handleAdbScreenshot({});
        assert.equal(transient.isError, false);
        assert.ok(
          transient.content.some((c) => c.type === "image"),
          "inline image must survive",
        );
        assert.doesNotMatch(
          text(transient),
          /Saved screenshot to/i,
          "a deleted temp path must not be advertised",
        );
        assert.match(text(transient), /transient|inline/i);

        const first = await readRecord(record);
        const remotes = first.filter((l) => l.startsWith("/sdcard/") && l.endsWith(".png"));
        assert.equal(remotes.length, 1, "remote capture path must be recorded");
        assert.notEqual(remotes[0], "/sdcard/screen.png", "remote path must be unique per capture");
        assert.ok(first.includes(`rm:${remotes[0]}`), "remote temp file must be cleaned up");

        const target = join(work, "kept shot.png");
        const persistent = await handleAdbScreenshot({ outputPath: target });
        assert.equal(persistent.isError, false);
        assert.ok(text(persistent).includes(target), "persistent path must be reported");
        assert.equal(
          await readFile(target, "utf8"),
          "PNGDATA",
          "persistent file must remain after return",
        );

        const secondRemotes = (await readRecord(record)).filter(
          (l) => l.startsWith("/sdcard/") && l.endsWith(".png"),
        );
        assert.notEqual(
          secondRemotes[0],
          secondRemotes[1],
          "two captures must not share a remote filename",
        );
      });

      await withStubs({ adb: stub }, async () => {
        // pull failure must be an error and still attempt remote cleanup
        process.env.PULL_FAIL = "1";
        const before = (await readRecord(record)).length;
        const failed = await handleAdbScreenshot({ outputPath: join(work, "never.png") });
        delete process.env.PULL_FAIL;
        assert.equal(failed.isError, true);
        assert.match(text(failed), /pull failed/);
        const after = (await readRecord(record)).slice(before);
        assert.ok(
          after.some((l) => l.startsWith("rm:/sdcard/")),
          "pull failure must still attempt remote cleanup",
        );
      });

      await withStubs({ adb: stub }, async () => {
        process.env.SCREENCAP_FAIL = "1";
        const failed = await handleAdbScreenshot({});
        delete process.env.SCREENCAP_FAIL;
        assert.equal(failed.isError, true);
        assert.match(text(failed), /screencap failed/);
        assert.doesNotMatch(text(failed), /Saved screenshot to/i);
      });
    } finally {
      delete process.env.RECORD;
      delete process.env.PULL_FAIL;
      delete process.env.SCREENCAP_FAIL;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "crash_summary distinguishes unavailable logcat from zero crashes (issue 87)",
  async () => {
    const record = RECORD();
    process.env.RECORD = record;
    const stub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "get-serialno" ]; then printf "emulator-5554\\n"; exit 0; fi',
      'if [ "$1" = "logcat" ] && [ "$2" = "-c" ]; then exit "${CLEAR_FAIL:-0}"; fi',
      'if [ "$1" = "logcat" ] && [ "$2" = "-d" ]; then',
      '  if [ -n "${COLLECT_FAIL:-}" ]; then printf "logcat: device offline\\n" >&2; exit 1; fi',
      '  printf "%b" "${LOGCAT_BODY:-}"; exit 0',
      "fi",
      "exit 0",
    ].join("\n");
    const runSummary = async (env = {}) => {
      Object.assign(process.env, env);
      try {
        return await handleCrashSummary({ durationSec: 0 });
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
    };
    try {
      await withStubs({ adb: stub }, async () => {
        const clean = await runSummary();
        assert.equal(clean.isError, false);
        assert.match(text(clean), /status=no-crashes-observed/);
        assert.match(text(clean), /crashes=0/);
        assert.match(text(clean), /device=emulator-5554/);
        assert.match(text(clean), /window=\S+\.\.\S+/);
        assert.match(text(clean), /duration=0s/);

        const crashes = await runSummary({
          LOGCAT_BODY: "FATAL EXCEPTION: main\\nAndroidRuntime: boom\\n",
        });
        assert.equal(crashes.isError, false);
        assert.match(text(crashes), /status=crashes-found/);
        assert.match(text(crashes), /crashes=2/);
        assert.match(text(crashes), /FATAL EXCEPTION/);

        const clearFailed = await runSummary({ CLEAR_FAIL: "1" });
        assert.equal(
          clearFailed.isError,
          true,
          "a failed logcat -c must not look like a clean run",
        );
        assert.match(text(clearFailed), /status=not-assessed/);
        assert.doesNotMatch(text(clearFailed), /no-crashes-observed/);

        const collectFailed = await runSummary({ COLLECT_FAIL: "1" });
        assert.equal(
          collectFailed.isError,
          true,
          "a failed logcat -d must not look like a clean run",
        );
        assert.match(text(collectFailed), /status=unavailable/);
        assert.match(text(collectFailed), /device offline/);
        assert.doesNotMatch(text(collectFailed), /no-crashes-observed/);
      });
    } finally {
      delete process.env.RECORD;
    }
  },
);

stubbedTests(
  "startup_time resolves the launcher and surfaces launch/timing failures (issue 85)",
  async () => {
    const record = RECORD();
    const counter = join(
      tmpdir(),
      `startup-counter-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.RECORD = record;
    process.env.STARTUP_COUNTER = counter;
    const stub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "shell" ] && [ "$2" = "cmd" ] && [ "$3" = "package" ] && [ "$4" = "resolve-activity" ]; then',
      '  if [ -n "${NO_LAUNCHER:-}" ]; then printf "No activity found\\n"; exit 0; fi',
      '  printf "priority=0\\ncom.example.app/.HomeScreen\\n"; exit 0',
      "fi",
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "start-activity" ]; then',
      '  if [ -n "${START_FAIL:-}" ]; then printf "Error: Activity not started\\n" >&2; exit 1; fi',
      '  if [ -n "${FAIL_FIRST:-}" ]; then',
      '    n=$(cat "$STARTUP_COUNTER" 2>/dev/null || echo 0); n=$((n+1)); printf "%s" "$n" > "$STARTUP_COUNTER"',
      '    if [ "$n" -eq 1 ]; then printf "first launch failed\\n" >&2; exit 1; fi',
      "  fi",
      '  if [ -n "${NO_TOTAL:-}" ]; then printf "Status: ok\\n"; exit 0; fi',
      '  printf "Status: ok\\nTotalTime: 123\\n"; exit 0',
      "fi",
      'if [ "$1" = "shell" ] && [ "$2" = "am" ] && [ "$3" = "force-stop" ]; then',
      '  if [ -n "${STOP_FAIL:-}" ]; then printf "force-stop failed\\n" >&2; exit 1; fi',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n");
    const runStartup = async (args, env = {}) => {
      Object.assign(process.env, env);
      try {
        return await handleStartupTime({ packageName: "com.example.app", iterations: 1, ...args });
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
    };
    try {
      await withStubs({ adb: stub }, async () => {
        const ok = await runStartup({});
        assert.equal(ok.isError, false);
        assert.match(text(ok), /activity=com\.example\.app\/\.HomeScreen/);
        assert.match(
          text(ok),
          /iteration=1 component=com\.example\.app\/\.HomeScreen launch_exit=0 time_ms=123 cleanup=ok result=measured/,
        );
        assert.match(text(ok), /summary=ok/);
        const args = await readRecord(record);
        assert.ok(
          args.some((l) => l.includes("resolve-activity") && l.includes("com.example.app")),
        );
        assert.ok(
          args.some(
            (l) => l.includes("start-activity") && l.includes("com.example.app/.HomeScreen"),
          ),
        );

        await rm(record).catch(() => {});
        const explicit = await runStartup({ activity: ".SettingsActivity" });
        assert.equal(explicit.isError, false);
        assert.match(text(explicit), /activity=com\.example\.app\/\.SettingsActivity/);
        assert.ok(
          (await readRecord(record)).some((l) => l.includes("com.example.app/.SettingsActivity")),
        );

        await rm(record).catch(() => {});
        const noLauncher = await runStartup({}, { NO_LAUNCHER: "1" });
        assert.equal(noLauncher.isError, true);
        assert.match(text(noLauncher), /could not resolve|launcher/i);

        const startFailed = await runStartup({}, { START_FAIL: "1" });
        assert.equal(startFailed.isError, true);
        assert.match(text(startFailed), /launch_exit=1/);
        assert.match(text(startFailed), /Activity not started/);

        const noMetric = await runStartup({}, { NO_TOTAL: "1" });
        assert.equal(
          noMetric.isError,
          true,
          "a missing TotalTime must not be reported as zero milliseconds",
        );
        assert.match(text(noMetric), /time_ms=unavailable/);
        assert.doesNotMatch(text(noMetric), /time_ms=0\b/);

        const stopFailed = await runStartup({}, { STOP_FAIL: "1" });
        assert.equal(stopFailed.isError, true);
        assert.match(text(stopFailed), /cleanup=force-stop-failed/);
        assert.match(text(stopFailed), /force-stop failed/);

        await rm(record).catch(() => {});
        const partial = await runStartup({ iterations: 2 }, { FAIL_FIRST: "1" });
        assert.equal(partial.isError, true);
        assert.match(text(partial), /iteration=1 .*result=failed/);
        assert.match(text(partial), /iteration=2 .*result=measured/);
        assert.match(text(partial), /summary=partial/);

        await rm(record).catch(() => {});
        const invalid = await runStartup({ activity: ".Evil; reboot" });
        assert.equal(
          invalid.isError,
          true,
          "activity must be validated before reaching the device shell",
        );
        assert.equal((await readRecord(record)).length, 0, "invalid activity must not invoke adb");
      });
    } finally {
      delete process.env.RECORD;
      delete process.env.STARTUP_COUNTER;
      await rm(counter, { force: true });
    }
  },
);

stubbedTests("build_variant maps variant labels to valid Gradle tasks (issue 83)", async () => {
  const record = RECORD();
  const work = await mkdtemp(join(tmpdir(), "android-mcp-variant-"));
  process.env.RECORD = record;
  process.env.TASKS_BODY = "assembleDebug\\nassembleRelease\\nassembleStagingDebug\\n";
  const stub = [
    'printf "%s\\n" "$*" >> "$RECORD"',
    'case "$1" in *:tasks) printf "%b" "$TASKS_BODY"; exit 0;; esac',
    'if [ -n "${BUILD_FAIL:-}" ]; then printf "build failed\\n" >&2; exit 1; fi',
    'printf "BUILD SUCCESSFUL\\n"; exit 0',
  ].join("\n");
  const build = async (args, env = {}) => {
    Object.assign(process.env, env);
    try {
      return await handleBuildVariant({ projectPath: work, ...args });
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  };
  try {
    await withStubs({ gradle: stub }, async () => {
      const debug = await build({ variant: "debug" });
      assert.equal(debug.isError, false);
      assert.match(text(debug), /task=:app:assembleDebug/);
      let calls = await readRecord(record);
      assert.equal(calls[0], ":app:tasks --all -q");
      assert.equal(calls[1], ":app:assembleDebug");

      await rm(record).catch(() => {});
      const release = await build({ variant: "release", offline: true });
      assert.equal(release.isError, false);
      assert.match(text(release), /task=:app:assembleRelease/);
      assert.equal((await readRecord(record))[1], ":app:assembleRelease --offline");

      await rm(record).catch(() => {});
      const flavor = await build({ variant: "stagingDebug" });
      assert.equal(flavor.isError, false);
      assert.match(text(flavor), /task=:app:assembleStagingDebug/);

      await rm(record).catch(() => {});
      const lib = await build({ variant: "debug", module: ":lib" });
      assert.equal(lib.isError, false);
      assert.match(text(lib), /task=:lib:assembleDebug/);
      assert.ok((await readRecord(record)).some((l) => l.startsWith(":lib:assembleDebug")));

      await rm(record).catch(() => {});
      const unknown = await build({ variant: "qaDebug" });
      assert.equal(
        unknown.isError,
        true,
        "an unknown variant must fail before the build task runs",
      );
      assert.match(text(unknown), /unknown variant|available/i);
      calls = await readRecord(record);
      assert.equal(calls.length, 1, "only task discovery may run for an unknown variant");
      assert.match(calls[0], /:tasks/);

      await rm(record).catch(() => {});
      const optionLike = await build({ variant: "-Ievil.gradle" });
      assert.equal(optionLike.isError, true);
      assert.equal(
        (await readRecord(record)).length,
        0,
        "option-like variant must never reach Gradle",
      );

      await rm(record).catch(() => {});
      const failed = await build({ variant: "debug" }, { BUILD_FAIL: "1" });
      assert.equal(failed.isError, true);
      assert.match(text(failed), /build failed/);
    });
  } finally {
    delete process.env.RECORD;
    delete process.env.TASKS_BODY;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests(
  "avd_wipe runs a bounded lifecycle and never touches other emulators (issue 86)",
  async () => {
    const record = RECORD();
    const pidFile = join(
      tmpdir(),
      `avd-wipe-pid-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.RECORD = record;
    process.env.EMULATOR_PID_FILE = pidFile;
    process.env.TARGET_AVD = "WipeMe";
    const adbStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "devices" ]; then',
      '  printf "List of devices attached\\n"',
      '  [ -n "${OTHER_SERIAL:-}" ] && printf "%s\\tdevice\\n" "$OTHER_SERIAL"',
      '  if [ -f "$EMULATOR_PID_FILE" ] && [ -z "${NEVER_READY:-}" ]; then printf "emulator-5556\\tdevice\\n"; fi',
      "  exit 0",
      "fi",
      'if [ "$1" = "-s" ]; then',
      '  serial="$2"; shift 2',
      '  if [ "$1" = "emu" ] && [ "$2" = "avd" ] && [ "$3" = "name" ]; then',
      '    case "$serial" in',
      '      emulator-5554) printf "%s\\nOK\\n" "${OTHER_AVD:-OtherAvd}" ;;',
      '      *) printf "%s\\nOK\\n" "$TARGET_AVD" ;;',
      "    esac",
      "    exit 0",
      "  fi",
      '  if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then',
      '    printf "%s\\n" "${BOOT_COMPLETED:-1}"; exit "${BOOT_PROP_FAIL:-0}"',
      "  fi",
      '  if [ "$1" = "emu" ] && [ "$2" = "kill" ]; then',
      '    if [ -n "${KILL_FAIL:-}" ]; then printf "kill failed\\n" >&2; exit 1; fi',
      '    [ -f "$EMULATOR_PID_FILE" ] && kill "$(cat "$EMULATOR_PID_FILE")" 2>/dev/null',
      "    exit 0",
      "  fi",
      "fi",
      "exit 0",
    ].join("\n");
    const emulatorStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "-list-avds" ]; then printf "%s\\n" "${AVD_LIST:-WipeMe}"; exit 0; fi',
      'printf "%s" "$$" > "$EMULATOR_PID_FILE"',
      'exec sleep "${EMULATOR_LIFETIME:-2}"',
    ].join("\n");
    const wipe = async (args, env = {}) => {
      Object.assign(process.env, env);
      try {
        return await handleAvdWipe({ avdName: "WipeMe", ...args });
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
    };
    const pidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await withStubs({ adb: adbStub, emulator: emulatorStub }, async () => {
        const optionLike = await handleAvdWipe({ avdName: "-wipe-data" });
        assert.equal(optionLike.isError, true);
        assert.equal(
          (await readRecord(record)).length,
          0,
          "option-like name must not spawn anything",
        );

        await rm(record).catch(() => {});
        const unknown = await wipe({}, { AVD_LIST: "OtherAvd" });
        assert.equal(unknown.isError, true);
        assert.match(text(unknown), /status=not-found/);
        assert.ok(
          !(await readRecord(record)).some((l) => l.includes("-wipe-data")),
          "unknown AVD must not launch",
        );

        await rm(record).catch(() => {});
        const running = await wipe({}, { OTHER_SERIAL: "emulator-5554", OTHER_AVD: "WipeMe" });
        assert.equal(running.isError, true, "an already-running target AVD must be refused");
        assert.match(text(running), /status=refused/);
        assert.match(text(running), /already-running/);
        assert.match(text(running), /emulator-5554/);

        await rm(record).catch(() => {});
        const success = await wipe({}, { OTHER_SERIAL: "emulator-5554", OTHER_AVD: "OtherAvd" });
        assert.equal(success.isError, false, text(success));
        assert.match(text(success), /status=ok/);
        assert.match(text(success), /wipe=complete/);
        assert.match(text(success), /serial=emulator-5556/);
        assert.match(text(success), /instance=stopped/);
        const calls = await readRecord(record);
        assert.ok(
          calls.some((l) => l.startsWith("-avd WipeMe -wipe-data")),
          "a controlled wipe instance must launch",
        );
        assert.ok(
          calls.some((l) => l === "-s emulator-5556 shell getprop sys.boot_completed"),
          "boot completion must be verified before success",
        );
        assert.ok(
          calls.some((l) => l === "-s emulator-5556 emu kill"),
          "shutdown must target the wipe serial",
        );
        assert.ok(
          !calls.some((l) => l.includes("emulator-5554") && l.includes("emu kill")),
          "other emulator must not be killed",
        );
        assert.ok(
          !calls.some((l) => l.includes("pkill") || l.includes("killall")),
          "no process-wide kill may be used",
        );

        await rm(record).catch(() => {});
        const timeout = await wipe(
          { timeoutSec: 1 },
          { OTHER_SERIAL: "emulator-5554", OTHER_AVD: "OtherAvd", NEVER_READY: "1" },
        );
        assert.equal(timeout.isError, true);
        assert.match(text(timeout), /status=timeout/);
        assert.match(text(timeout), /wipe=indeterminate/);
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.ok(
          !pidAlive(pid),
          "the temporary emulator created by this operation must be terminated",
        );
        const timeoutCalls = await readRecord(record);
        assert.ok(!timeoutCalls.some((l) => l.includes("emulator-5554") && l.includes("emu kill")));

        await rm(record).catch(() => {});
        await rm(pidFile, { force: true });
        const killFailed = await wipe(
          {},
          { OTHER_SERIAL: "emulator-5554", OTHER_AVD: "OtherAvd", KILL_FAIL: "1" },
        );
        assert.equal(
          killFailed.isError,
          true,
          "a failed shutdown must not be reported as cleanly stopped",
        );
        assert.match(text(killFailed), /status=shutdown-failed/);
        assert.match(text(killFailed), /shutdown=failed/);
        assert.doesNotMatch(text(killFailed), /instance=stopped/);
        const failedPid = Number(await readFile(pidFile, "utf8"));
        assert.ok(!pidAlive(failedPid), "the failed instance must not be leaked");
      });
    } finally {
      const stray = await readFile(pidFile, "utf8").catch(() => "");
      if (stray) {
        try {
          process.kill(Number(stray), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      delete process.env.RECORD;
      delete process.env.EMULATOR_PID_FILE;
      delete process.env.TARGET_AVD;
      await rm(pidFile, { force: true });
    }
  },
);

stubbedTests("apk_serve reports a missing python3 and writes no state (issue 81)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const empty = join(work, "empty-bin");
  await mkdir(empty);
  const statePath = join(work, "serve-state.json");
  const oldPath = process.env.PATH;
  process.env.ANDROID_MCP_SERVE_STATE = statePath;
  process.env.PATH = empty;
  try {
    const r = await handleApkServe({ action: "start", dir: work, port: 18099 });
    assert.equal(r.isError, true, "a missing python3 must be an MCP error");
    assert.match(text(r), /python3|spawn|not found|ENOENT/i);
    assert.equal(
      await readFile(statePath, "utf8")
        .then(() => true)
        .catch(() => false),
      false,
      "no state may be written before the server is ready",
    );
  } finally {
    process.env.PATH = oldPath;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests(
  "apk_serve rejects an early exit and a bind conflict, leaving no state (issue 81)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
    const record = RECORD();
    const statePath = join(work, "serve-state.json");
    process.env.RECORD = record;
    process.env.ANDROID_MCP_SERVE_STATE = statePath;
    try {
      await withStubs({ python3: `${APPEND_ARGS}; exit 3` }, async () => {
        const r = await handleApkServe({ action: "start", dir: work, port: 18099 });
        assert.equal(r.isError, true, "a server that exits immediately must be an error");
        assert.match(text(r), /exit|exited/i);
        assert.equal(
          await readFile(statePath, "utf8")
            .then(() => true)
            .catch(() => false),
          false,
        );
      });

      const port = await freePort();
      const blocker = net.createServer();
      const blockedSockets = new Set();
      blocker.on("connection", (socket) => {
        blockedSockets.add(socket);
        socket.once("close", () => blockedSockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, "127.0.0.1", resolve);
      });
      try {
        await withStubs({ python3: await httpServerStub(work) }, async () => {
          const r = await handleApkServe({ action: "start", dir: work, port });
          assert.equal(r.isError, true, "a bind conflict must be an error");
          assert.match(text(r), /address|in use|exit|exited/i);
          assert.equal(
            await readFile(statePath, "utf8")
              .then(() => true)
              .catch(() => false),
            false,
          );
        });
      } finally {
        for (const socket of blockedSockets) socket.destroy();
        await new Promise((resolve) => blocker.close(() => resolve()));
      }
    } finally {
      delete process.env.RECORD;
      delete process.env.ANDROID_MCP_SERVE_STATE;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "apk_serve readiness timeout terminates only its child and leaves no state (issue 81)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
    const pidFile = join(work, "serve.pid");
    const statePath = join(work, "serve-state.json");
    process.env.SERVE_PID_FILE = pidFile;
    process.env.ANDROID_MCP_SERVE_STATE = statePath;
    try {
      await withStubs(
        { python3: 'printf "%s" "$$" > "$SERVE_PID_FILE"; exec sleep 30' },
        async () => {
          const r = await handleApkServe({
            action: "start",
            dir: work,
            port: await freePort(),
            readyTimeoutSec: 1,
          });
          assert.equal(r.isError, true);
          assert.match(text(r), /status=timeout/);
          assert.equal(
            await readFile(statePath, "utf8")
              .then(() => true)
              .catch(() => false),
            false,
          );
        },
      );
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(await waitForPidGone(pid), "the timed-out server must be terminated");
    } finally {
      delete process.env.SERVE_PID_FILE;
      delete process.env.ANDROID_MCP_SERVE_STATE;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests("apk_serve stop refuses to signal a reused stale pid (issue 81)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const statePath = join(work, "serve-state.json");
  process.env.ANDROID_MCP_SERVE_STATE = statePath;
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await writeFile(
      statePath,
      JSON.stringify({ pid: sleeper.pid, port: 18099, dir: work, bind: "127.0.0.1" }),
    );
    const r = await handleApkServe({ action: "stop" });
    assert.equal(r.isError, true, "an unowned pid must not be reported as a clean stop");
    assert.match(text(r), /refused|identity|stale|not-stopped/i);
    assert.equal(sleeper.exitCode, null, "an unrelated process must not be signalled");
    assert.equal(
      await readFile(statePath, "utf8")
        .then(() => true)
        .catch(() => false),
      false,
      "the unusable state file must be discarded",
    );
  } finally {
    sleeper.kill("SIGKILL");
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests("apk_serve stop confirms the verified listener is gone (issue 81)", async () => {
  const work = await mkdtemp(join(tmpdir(), "android-mcp-serve-work-"));
  const record = RECORD();
  const statePath = join(work, "serve-state.json");
  const port = await freePort();
  process.env.RECORD = record;
  process.env.ANDROID_MCP_SERVE_STATE = statePath;
  try {
    await withStubs({ python3: await httpServerStub(work) }, async () => {
      const started = await handleApkServe({ action: "start", dir: work, port });
      assert.equal(started.isError, false, text(started));
      assert.ok(await portResponds(port));
      const stopped = await handleApkServe({ action: "stop" });
      assert.equal(stopped.isError, false, text(stopped));
      assert.match(text(stopped), /status=stopped/);
      assert.equal(
        await readFile(statePath, "utf8")
          .then(() => true)
          .catch(() => false),
        false,
        "stop must remove the state file",
      );
    });
  } finally {
    delete process.env.RECORD;
    delete process.env.ANDROID_MCP_SERVE_STATE;
    await rm(work, { recursive: true, force: true });
  }
});

stubbedTests(
  "emulator_boot reports list and spawn failures instead of claiming success (issue 81)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-boot-"));
    const record = RECORD();
    const empty = join(work, "empty-bin");
    await mkdir(empty);
    const oldPath = process.env.PATH;
    process.env.RECORD = record;
    try {
      process.env.PATH = empty;
      const missing = await handleEmulatorBoot({ avdName: "BootMe" });
      assert.equal(missing.isError, true, "a missing emulator must be an MCP error");
      assert.match(text(missing), /unavailable|list-avds|emulator/i);

      process.env.PATH = oldPath;
      const adbStub = [
        'printf "%s\\n" "$*" >> "$RECORD"',
        'if [ "$1" = "devices" ]; then printf "List of devices attached\\n"; exit 0; fi',
        "exit 0",
      ].join("\n");
      const earlyExit = [
        'printf "%s\\n" "$*" >> "$RECORD"',
        'if [ "$1" = "-list-avds" ]; then printf "BootMe\\n"; exit 0; fi',
        "exit 1",
      ].join("\n");
      await withStubs({ adb: adbStub, emulator: earlyExit }, async () => {
        const failed = await handleEmulatorBoot({ avdName: "BootMe", timeoutSec: 2 });
        assert.equal(failed.isError, true);
        assert.match(text(failed), /status=exited/);
        assert.doesNotMatch(text(failed), /status=ready|Booted AVD/i);
      });
    } finally {
      process.env.PATH = oldPath;
      delete process.env.RECORD;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "emulator_boot times out and terminates the instance it launched (issue 81)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-boot-"));
    const pidFile = join(work, "boot.pid");
    const record = RECORD();
    process.env.RECORD = record;
    process.env.EMULATOR_PID_FILE = pidFile;
    process.env.BOOT_COMPLETED = "0";
    const adbStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "devices" ]; then',
      '  printf "List of devices attached\\n"',
      '  if [ -f "$EMULATOR_PID_FILE" ] && [ -z "${NEVER_READY:-}" ]; then printf "emulator-5556\\tdevice\\n"; fi',
      "  exit 0",
      "fi",
      'if [ "$1" = "-s" ]; then',
      '  serial="$2"; shift 2',
      '  if [ "$1" = "emu" ] && [ "$2" = "avd" ] && [ "$3" = "name" ]; then printf "BootMe\\nOK\\n"; exit 0; fi',
      '  if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then printf "%s\\n" "$BOOT_COMPLETED"; exit 0; fi',
      '  if [ "$1" = "emu" ] && [ "$2" = "kill" ]; then [ -f "$EMULATOR_PID_FILE" ] && kill "$(cat "$EMULATOR_PID_FILE")" 2>/dev/null; exit 0; fi',
      "fi",
      "exit 0",
    ].join("\n");
    const emulatorStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "-list-avds" ]; then printf "BootMe\\n"; exit 0; fi',
      'printf "%s" "$$" > "$EMULATOR_PID_FILE"',
      'exec sleep "${EMULATOR_LIFETIME:-30}"',
    ].join("\n");
    const pidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await withStubs({ adb: adbStub, emulator: emulatorStub }, async () => {
        const bootTimeout = await handleEmulatorBoot({ avdName: "BootMe", timeoutSec: 2 });
        assert.equal(bootTimeout.isError, true);
        assert.match(text(bootTimeout), /status=timeout/);
        assert.match(text(bootTimeout), /phase=boot/);
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.ok(!pidAlive(pid), "a boot timeout must terminate the launched instance");
        assert.ok(
          (await readRecord(record)).some((l) => l === "-s emulator-5556 emu kill"),
          "a boot timeout must ask the exact serial to shut down",
        );

        await rm(record).catch(() => {});
        await rm(pidFile, { force: true });
        process.env.NEVER_READY = "1";
        const neverReady = await handleEmulatorBoot({ avdName: "BootMe", timeoutSec: 2 });
        delete process.env.NEVER_READY;
        assert.equal(neverReady.isError, true);
        assert.match(text(neverReady), /status=timeout/);
        const secondPid = Number(await readFile(pidFile, "utf8"));
        assert.ok(!pidAlive(secondPid), "a never-ready instance must be terminated");
        assert.doesNotMatch(text(neverReady), /status=ready/);
      });
    } finally {
      delete process.env.RECORD;
      delete process.env.EMULATOR_PID_FILE;
      delete process.env.BOOT_COMPLETED;
      delete process.env.NEVER_READY;
      await rm(work, { recursive: true, force: true });
    }
  },
);

stubbedTests(
  "emulator_boot only reports ready after ADB identity and boot completion (issue 81)",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "android-mcp-boot-"));
    const pidFile = join(work, "boot.pid");
    const record = RECORD();
    process.env.RECORD = record;
    process.env.EMULATOR_PID_FILE = pidFile;
    process.env.BOOT_COMPLETED = "1";
    const adbStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "devices" ]; then',
      '  printf "List of devices attached\\n"',
      '  [ -n "${OTHER_SERIAL:-}" ] && printf "%s\\tdevice\\n" "$OTHER_SERIAL"',
      '  [ -f "$EMULATOR_PID_FILE" ] && printf "emulator-5556\\tdevice\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "-s" ]; then',
      '  serial="$2"; shift 2',
      '  if [ "$1" = "emu" ] && [ "$2" = "avd" ] && [ "$3" = "name" ]; then',
      '    case "$serial" in emulator-5554) printf "OtherAvd\\nOK\\n" ;; *) printf "BootMe\\nOK\\n" ;; esac',
      "    exit 0",
      "  fi",
      '  if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then printf "%s\\n" "$BOOT_COMPLETED"; exit 0; fi',
      "fi",
      "exit 0",
    ].join("\n");
    const emulatorStub = [
      'printf "%s\\n" "$*" >> "$RECORD"',
      'if [ "$1" = "-list-avds" ]; then printf "BootMe\\n"; exit 0; fi',
      'printf "%s" "$$" > "$EMULATOR_PID_FILE"',
      'exec sleep "${EMULATOR_LIFETIME:-30}"',
    ].join("\n");
    try {
      await withStubs({ adb: adbStub, emulator: emulatorStub }, async () => {
        const started = await handleEmulatorBoot({
          avdName: "BootMe",
          timeoutSec: 5,
          // other emulator present must not be mistaken for the new instance
        });
        assert.equal(started.isError, false, text(started));
        assert.match(text(started), /status=ready/);
        assert.match(text(started), /avd=BootMe/);
        assert.match(text(started), /serial=emulator-5556/);
        assert.match(text(started), /boot=sys\.boot_completed=1/);
        assert.match(text(started), /pid=\d+/);
        const calls = await readRecord(record);
        assert.ok(
          calls.some((l) => l === "-s emulator-5556 shell getprop sys.boot_completed"),
          "readiness must include a boot completion query",
        );
        assert.ok(
          calls.some((l) => l === "-s emulator-5556 emu avd name"),
          "the new instance must be identified by AVD name, not just its serial",
        );
        assert.ok(!calls.some((l) => l.includes("emulator-5554") && l.includes("emu kill")));
      });
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      delete process.env.RECORD;
      delete process.env.EMULATOR_PID_FILE;
      delete process.env.BOOT_COMPLETED;
      await rm(work, { recursive: true, force: true });
    }
  },
);
