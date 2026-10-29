// Contract test for the shared Frida/mitmproxy helper module (src/frida.ts).
// Run from the repo root after `npm run build`: node test/frida.test.mjs
//
// The ensureServer/deviceAbi flows need a booted, rootable AVD and are covered
// by the manual emulator smoke run; here we pin the pure/unit-level behaviour
// that tools depend on.
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mapAbiToAsset,
  parseBuildType,
  resolveFridaCli,
  resolveMitmDump,
  PIDFILE,
} from "../dist/frida.js";
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

rmSync(fake, { recursive: true, force: true });
rmSync(noexecRoot, { recursive: true, force: true });

console.log("frida helper test passed");
