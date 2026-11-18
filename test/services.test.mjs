// ISSUE-96: approved process services are the only route to host execution and
// detached children. These tests exercise the real OS seams: argv boundaries,
// metacharacters, failures, exit codes, timeouts and process ownership.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skip, test } from "node:test";

import { run } from "../dist/services/process-runner.js";
import { spawnManaged } from "../dist/services/managed-process.js";
import {
  adbArgs,
  resolveActivityComponent,
  shquote,
  validateComponent,
  validateIntentAction,
  validateRemotePath,
} from "../dist/services/adb-client.js";

const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "android-mcp-services-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitGone(pid, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

test("argv execution preserves spaces, quotes and shell metacharacters as data", async () => {
  const f = fixture();
  try {
    const marker = join(f.dir, "injected");
    const argument = `a b "c" 'd' ; touch ${marker}; echo pwned`;
    const result = await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", argument]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, argument);
    assert.equal(existsSync(marker), false, "host metacharacters must not start a second command");
  } finally {
    f.cleanup();
  }
});

test("a non-zero exit is reported instead of being converted into success", async () => {
  const result = await run(process.execPath, ["-e", 'process.stderr.write("nope"); process.exit(7)']);
  assert.equal(result.code, 7);
  assert.match(result.stderr, /nope/);
});

test("a timeout is bounded and reported as a failure", async () => {
  const result = await run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeout: 100,
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
});

test("a missing executable produces an error result, not an unhandled exception", async () => {
  const missing = join(tmpdir(), `android-mcp-missing-${process.pid}-${Date.now()}`);
  const result = await run(missing, []);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ENOENT|not found/i);
});

test("a detached child reports readiness, identity and a bounded shutdown", async () => {
  const f = fixture();
  const child = spawnManaged(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  try {
    const pid = await child.waitForSpawn();
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(child.isRunning(), true);
    assert.equal(await child.waitForExit(50), false, "a live child is not reported as exited");
    assert.notEqual(await child.stop(), "still-running");
    assert.equal(await waitGone(pid), true, "the owned child must be gone");
    assert.equal(child.isRunning(), false);
    assert.equal(await child.stop(), "already-exited");
  } finally {
    await child.stop();
    f.cleanup();
  }
});

test("stopping one managed child never signals an unrelated process", async () => {
  const decoy = spawnManaged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const target = spawnManaged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    const decoyPid = await decoy.waitForSpawn();
    const targetPid = await target.waitForSpawn();
    await target.stop();
    assert.equal(await waitGone(targetPid), true);
    assert.equal(await decoy.waitForExit(0), false);
    assert.equal(decoy.isRunning(), true, "an unrelated process must stay alive");
    assert.equal(alive(decoyPid), true);
  } finally {
    await target.stop();
    await decoy.stop();
  }
});

test("a spawn error is surfaced through the managed handle without crashing the process", async () => {
  const missing = join(tmpdir(), `android-mcp-missing-${process.pid}-${Date.now()}`);
  const child = spawnManaged(missing, [], { detached: true, stdio: "ignore" });
  await assert.rejects(child.waitForSpawn(), /ENOENT|not found/i);
  assert.equal(child.isRunning(), false);
  assert.equal(await child.stop(), "not-spawned");
});

test("a child that exits before readiness is not reported ready", async () => {
  const child = spawnManaged(process.execPath, ["-e", "process.exit(3)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = await child.waitForSpawn();
  assert.ok(pid > 0);
  assert.equal(await child.waitForExit(5_000), true);
  assert.equal(child.isRunning(), false);
  assert.equal(child.exitCode, 3);
});

test("device selection is an argv pair, never a concatenated command", () => {
  assert.deepEqual(adbArgs(), []);
  assert.deepEqual(adbArgs("emulator-5554"), ["-s", "emulator-5554"]);
  assert.deepEqual(adbArgs("a b; reboot"), ["-s", "a b; reboot"]);
});

posixTest("remote quoting keeps shell metacharacters inside one argument", () => {
  const payload = `a b "c" 'd' ; id $(id) \`id\` | cat > /tmp/pwned`;
  const output = execFileSync("/bin/sh", ["-c", `printf %s ${shquote(payload)}`], {
    encoding: "utf8",
  });
  assert.equal(output, payload);
});

test("destructive remote paths outside scope or with traversal are rejected", () => {
  assert.equal(validateRemotePath("/sdcard/Download/file.txt"), true);
  assert.equal(validateRemotePath("/data/local/tmp/app.tar"), true);
  for (const bad of [
    "relative/file.txt",
    "/sdcard/../data/data/pkg/db",
    "/sdcard/a;reboot",
    "/sdcard/a$(reboot)",
    "/sdcard/a`reboot`",
    "/sdcard/a|cat",
    "/etc/passwd",
    "/sdcard/" + "x".repeat(10) + "\nreboot",
  ]) {
    assert.equal(validateRemotePath(bad), false, `${bad} must be rejected`);
  }
});

test("intent actions and components have constrained grammars", () => {
  assert.equal(validateIntentAction("android.intent.action.VIEW"), true);
  assert.equal(validateIntentAction("android.intent.action.VIEW;reboot"), false);
  assert.equal(validateIntentAction("android..VIEW"), false);
  assert.equal(validateComponent("com.example.app/MainActivity"), true);
  assert.equal(validateComponent("com.example.app/com.example.app.MainActivity"), true);
  assert.equal(validateComponent("com.example.app/');reboot;('"), false);
});

test("activity names resolve only inside the requested package", () => {
  assert.equal(resolveActivityComponent("com.example", ".Main"), "com.example/com.example.Main");
  assert.equal(resolveActivityComponent("com.example", "Main"), "com.example/com.example.Main");
  assert.equal(
    resolveActivityComponent("com.example", "com.example.ui.Main"),
    "com.example/com.example.ui.Main",
  );
  assert.equal(resolveActivityComponent("com.example", "com.other.Main"), null);
  assert.equal(resolveActivityComponent("com.example", ".Main;reboot"), null);
  assert.equal(resolveActivityComponent("com.example", "com.example.Main/extra"), null);
});

