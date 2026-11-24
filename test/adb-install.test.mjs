// ISSUE-145: adb_install must install a complete split APK set with
// `adb install-multiple -r`, while the legacy single-APK request keeps using
// `adb install -r`. Validate every path before any device call.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work = mkdtempSync(join(tmpdir(), "adb-install-"));
const bin = join(work, "bin");
const record = join(work, "args.txt");
mkdirSync(bin, { recursive: true });
const stub = String.raw`#!/bin/sh
: > "$STUB_RECORD"
for arg in "$@"; do printf '%s\n' "$arg" >> "$STUB_RECORD"; done
printf '%s\n' "--" >> "$STUB_RECORD"
printf '%s' "$STUB_OUT"
exit "$STUB_EXIT"
`;
writeFileSync(join(bin, "adb"), stub);
chmodSync(join(bin, "adb"), 0o755);
const basePath = process.env.PATH ?? "";
process.env.PATH = `${bin}:${basePath}`;
process.env.STUB_RECORD = record;
const { test: nodeTest, skip } = await import("node:test");
// POSIX shell stubs cannot be spawned on Windows; full coverage runs in the
// Linux CI job, matching the convention used by test/tools.test.mjs.
const test = process.platform === "win32" ? (name, fn) => skip(name, fn) : nodeTest;
test.after = nodeTest.after;
const { handleAdbInstall } = await import("../dist/tools.js");
function apk(name) {
  const path = join(work, name);
  writeFileSync(path, "PK");
  return path;
}
const base = apk("base.apk");
const abi = apk("split_config.arm64_v8a.apk");
const density = apk("split_config.xxhdpi.apk");
function reset({ exit = 0, out = "" } = {}) {
  writeFileSync(record, "");
  process.env.STUB_EXIT = String(exit);
  process.env.STUB_OUT = out;
}
function calls() {
  return readFileSync(record, "utf8")
    .split("\n")
    .filter((line) => line !== "" && line !== "--");
}
test.after(() => rmSync(work, { recursive: true, force: true }));
test("single APK keeps adb install -r and device targeting", async () => {
  reset();
  const result = await handleAdbInstall({ apkPath: base, deviceId: "emulator-5554" });
  assert.equal(result.isError, false);
  assert.deepEqual(calls(), ["-s", "emulator-5554", "install", "-r", base]);
});
test("split set uses install-multiple -r with every APK in supplied order", async () => {
  reset();
  const result = await handleAdbInstall({ apkPaths: [base, abi, density] });
  assert.equal(result.isError, false);
  assert.deepEqual(calls(), ["install-multiple", "-r", base, abi, density]);
});
test("empty, duplicate, missing and non-APK paths fail before any device call", async () => {
  const missing = join(work, "missing.apk");
  const text = join(work, "notes.txt");
  writeFileSync(text, "x");
  for (const args of [
    { apkPaths: [] },
    { apkPaths: [base, base] },
    { apkPaths: [base, missing] },
    { apkPaths: [base, text] },
    { apkPath: base, apkPaths: [base] },
  ]) {
    reset();
    const result = await handleAdbInstall(args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(calls().length, 0, JSON.stringify(args));
  }
});
test("missing-split failure adds an actionable recovery hint", async () => {
  reset({ exit: 1, out: "Failure [INSTALL_FAILED_MISSING_SPLIT: Missing split for pkg]" });
  const result = await handleAdbInstall({ apkPath: base });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /complete base \+ config set/i);
  assert.match(result.content[0].text, /install-multiple/);
});
