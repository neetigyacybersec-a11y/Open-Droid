// Contract test for the shared Frida/mitmproxy helper module (src/frida.ts).
// Run from the repo root after `npm run build`: node test/frida.test.mjs
//
// The ensureServer/deviceAbi flows need a booted, rootable AVD and are covered
// by the manual emulator smoke run; here we pin the pure/unit-level behaviour
// that tools depend on.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapAbiToAsset,
  parseBuildType,
  resolveFridaCli,
  resolveMitmDump,
  pidRunning,
  PIDFILE,
} from "../dist/frida.js";
import { ToolSchemas, handleFridaHook, handleNetCapture } from "../dist/tools.js";
import { which } from "../dist/util.js";

// --- ABI mapping: device getprop ABI -> frida-server release asset suffix ---
assert.equal(mapAbiToAsset("x86_64"), "x86_64");
assert.equal(mapAbiToAsset("arm64-v8a"), "arm64");
assert.throws(() => mapAbiToAsset("mips"), /unsupported device ABI/);
assert.throws(() => mapAbiToAsset("armeabi-v7a"), /unsupported device ABI: armeabi-v7a/);

// --- Rootability: adb root only works on userdebug/eng images ---
assert.equal(parseBuildType("userdebug"), "rootable");
assert.equal(parseBuildType("eng"), "rootable");
assert.equal(parseBuildType("user"), "nonrootable");
assert.equal(parseBuildType("release-keys"), "nonrootable");
assert.equal(parseBuildType(""), "nonrootable");

// --- CLI resolution: vendored venv wins over PATH (offline-first) ---
const fake = mkdtempSync(join(tmpdir(), "venvtest-"));
const binDir = join(fake, ".toolchain", "python-venv", "bin");
mkdirSync(binDir, { recursive: true });
const f = join(binDir, "frida");
writeFileSync(f, "#!/bin/sh\n");
chmodSync(f, 0o755);
assert.equal(await resolveFridaCli(fake), f);

const mitm = join(binDir, "mitmdump");
writeFileSync(mitm, "#!/bin/sh\n");
chmodSync(mitm, 0o755);
assert.equal(await resolveMitmDump(fake), mitm);

// A non-executable vendored binary must be ignored (falls back to PATH or null).
const noexecRoot = mkdtempSync(join(tmpdir(), "venvtest-"));
const noexecBin = join(noexecRoot, ".toolchain", "python-venv", "bin");
mkdirSync(noexecBin, { recursive: true });
writeFileSync(join(noexecBin, "frida"), "#!/bin/sh\n", { mode: 0o644 });
chmodSync(join(noexecBin, "frida"), 0o644);
assert.equal(await resolveFridaCli(noexecRoot), await which("frida"));

// Missing root behaves exactly like the PATH fallback.
assert.equal(await resolveFridaCli("/nonexistent-root-xyz"), await which("frida"));
assert.equal(await resolveMitmDump("/nonexistent-root-xyz"), await which("mitmdump"));

// --- Shared state path ---
assert.equal(PIDFILE, join(tmpdir(), "android-mcp-mitm.pid"));

// --- MCP tool schemas (Task 6): defaults and required fields the handlers rely on ---
const hookDefaults = ToolSchemas.fridaHook.parse({ packageName: "com.example.app" });
assert.equal(hookDefaults.spawn, true);
assert.equal(hookDefaults.durationSec, 30);
assert.equal(hookDefaults.script, undefined);
assert.equal(hookDefaults.scriptPath, undefined);

const hookAttach = ToolSchemas.fridaHook.parse({
  packageName: "com.example.app",
  spawn: false,
  durationSec: 5,
});
assert.equal(hookAttach.spawn, false);
assert.equal(hookAttach.durationSec, 5);

const traceDefaults = ToolSchemas.fridaTraceMethods.parse({
  packageName: "com.example.app",
  className: "com.example.app.Crypto",
});
assert.equal(traceDefaults.methodRegex, ".*");
assert.equal(traceDefaults.durationSec, 30);

assert.throws(() => ToolSchemas.fridaHook.parse({ script: "console.log(1)" }));
assert.throws(() => ToolSchemas.fridaTraceMethods.parse({ packageName: "com.example.app" }));
assert.deepEqual(ToolSchemas.fridaPs.parse({}), {});

// The handler rejects a missing script before it ever resolves the frida CLI,
// so this stays host-independent on machines without frida installed.
await assert.rejects(
  handleFridaHook({ packageName: "com.example.app" }),
  /hook script.*script.*scriptPath/,
);

rmSync(fake, { recursive: true, force: true });
rmSync(noexecRoot, { recursive: true, force: true });

// --- Capture liveness + net_capture schema (Task 7) ---
assert.equal(pidRunning(-1), false); // dead/invalid pid -> false
assert.equal(pidRunning(0), false);
assert.equal(pidRunning(999999999), false);
assert.equal(pidRunning(process.pid), true); // this test process -> true

const captureDefaults = ToolSchemas.netCapture.parse({ action: "start" });
assert.equal(captureDefaults.port, 8080);
assert.equal(captureDefaults.durationSec, 30);
assert.equal(captureDefaults.deviceId, undefined);

const captureStop = ToolSchemas.netCapture.parse({
  action: "stop",
  deviceId: "emulator-5554",
  port: 9090,
  durationSec: 5,
});
assert.equal(captureStop.action, "stop");
assert.equal(captureStop.deviceId, "emulator-5554");
assert.equal(captureStop.port, 9090);
assert.equal(captureStop.durationSec, 5);

assert.throws(() => ToolSchemas.netCapture.parse({ action: "restart" }));
assert.throws(() => ToolSchemas.netCapture.parse({}));

// Argument validation happens before mitmdump is resolved, so these are
// host-independent and safe to run on a machine without a device.
await assert.rejects(
  handleNetCapture({ action: "start", port: 0 }),
  /invalid port 0/
);
await assert.rejects(
  handleNetCapture({ action: "start", port: 8080, durationSec: 0 }),
  /invalid durationSec 0/
);

// The busy guard must fire before any mitmdump/adb work. Only run it when no
// real capture owns the pidfile, so a developer's live session is never lost.
if (!existsSync(PIDFILE)) {
  writeFileSync(PIDFILE, `${process.pid}\n/tmp/should-not-be-used.har\n`);
  try {
    await assert.rejects(
      handleNetCapture({ action: "start", port: 12345, durationSec: 5 }),
      /net_capture busy: capture running \(pidfile .*android-mcp-mitm\.pid, port 12345\)/
    );
  } finally {
    rmSync(PIDFILE, { force: true });
  }
} else {
  console.log("skipping net_capture busy assertion: a capture owns", PIDFILE);
}

console.log("frida helper test passed");
