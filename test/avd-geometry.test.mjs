// ISSUE-12 / FR-D1: a 1080x2424 AVD on a small high-DPI host opens a cropped
// emulator window. emulator_boot must accept scale/window overrides, doctor must
// warn from AVD geometry, and a high-DPI profile must ship with the repo.
import { test, skip } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

const { ToolSchemas, handleEmulatorBoot, handleAdbWindowGeometry } =
  await import("../dist/tools.js");

// --- schema -----------------------------------------------------------------
test("emulator_boot accepts validated scale and windowSize overrides", () => {
  const parsed = ToolSchemas.emulatorBoot.parse({
    avdName: "Pixel_9_API_35",
    headless: false,
    scale: 0.5,
    windowSize: "900x600",
  });
  assert.equal(parsed.scale, 0.5);
  assert.equal(parsed.windowSize, "900x600");

  assert.throws(() => ToolSchemas.emulatorBoot.parse({ avdName: "P", scale: 0 }));
  assert.throws(() => ToolSchemas.emulatorBoot.parse({ avdName: "P", scale: 4 }));
  assert.throws(() => ToolSchemas.emulatorBoot.parse({ avdName: "P", windowSize: "big" }));
  assert.throws(() => ToolSchemas.emulatorBoot.parse({ avdName: "P", windowSize: "0x600" }));
});

// --- geometry helper --------------------------------------------------------
function runGeometry(args, env = {}) {
  return spawnSync("node", ["scripts/avd-geometry.mjs", ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function makeAvdDir(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "avd-geometry-"));
  for (const [name, config] of Object.entries(entries)) {
    const avd = path.join(dir, `${name}.avd`);
    mkdirSync(avd, { recursive: true });
    writeFileSync(path.join(avd, "config.ini"), config);
  }
  return dir;
}

test("geometry check warns when lcdHeight x scale exceeds the host height", () => {
  const dir = makeAvdDir({
    Pixel_9_API_35: "hw.lcd.width=1080\nhw.lcd.height=2424\nhw.lcd.density=420\n",
    Tablet_API_35: "hw.lcd.width=2560\nhw.lcd.height=600\n",
  });
  try {
    const r = runGeometry(["--avd-dir", dir, "--host-height", "864", "--scale", "1.25", "--check"]);
    assert.notEqual(r.status, 0, "a cropped AVD must make --check fail");
    assert.match(r.stdout, /Pixel_9_API_35/);
    assert.match(r.stdout, /1080x2424/);
    assert.match(r.stdout, /needs 3030/);
    assert.match(r.stdout, /host height 864/);
    assert.match(r.stdout, /-scale 0\.35/);
    assert.doesNotMatch(r.stdout, /Tablet_API_35.*cropped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("geometry check passes when the window fits, and handles no AVDs", () => {
  const fits = makeAvdDir({ Small: "hw.lcd.width=800\nhw.lcd.height=600\n" });
  const empty = mkdtempSync(path.join(tmpdir(), "avd-empty-"));
  try {
    const ok = runGeometry(["--avd-dir", fits, "--host-height", "864", "--scale", "1", "--check"]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /OK/);

    const none = runGeometry(["--avd-dir", empty, "--host-height", "864", "--check"]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no AVDs/i);
  } finally {
    rmSync(fits, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("geometry helper prints a concrete scale suggestion", () => {
  const dir = makeAvdDir({ Tall: "hw.lcd.width=1080\nhw.lcd.height=2400\n" });
  try {
    const r = runGeometry(["--avd-dir", dir, "--host-height", "800", "--scale", "1", "--suggest"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Tall/);
    assert.match(r.stdout, /-scale 0\.33/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- shipped profile and doctor wiring --------------------------------------
test("a high-DPI small-host AVD profile is shipped and documented", () => {
  const profile = path.join(REPO, "templates/avd/high-dpi-small-host.config.ini");
  assert.ok(existsSync(profile), "templates/avd/high-dpi-small-host.config.ini must exist");
  const text = readFileSync(profile, "utf8");
  assert.match(text, /^# .*125%|high-DPI|small host/im);
  assert.match(text, /^hw\.lcd\.width=\d+$/m);
  assert.match(text, /^hw\.lcd\.height=\d+$/m);
  assert.match(text, /emulator_boot/);
});

test("doctor wires the AVD geometry check", () => {
  const doctor = readFileSync(path.join(REPO, "scripts/doctor.sh"), "utf8");
  assert.match(doctor, /avd-geometry\.mjs/);
});

// --- handler argv (POSIX stubs) --------------------------------------------
posixTest("windowed emulator_boot passes -scale and -skin overrides", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "boot-geometry-"));
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const pidFile = path.join(work, "boot.pid");
  const record = path.join(work, "record.txt");
  const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\n'
  [ -f "$EMULATOR_PID_FILE" ] && printf 'emulator-5556\tdevice\n'
  exit 0
fi
if [ "$1" = "-s" ]; then
  shift 2
  if [ "$1" = "emu" ] && [ "$2" = "avd" ] && [ "$3" = "name" ]; then printf 'Pixel\nOK\n'; exit 0; fi
  if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then printf '1\n'; exit 0; fi
  exit 0
fi
exit 0
`;
  const emulatorStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "-list-avds" ]; then printf 'Pixel\n'; exit 0; fi
printf '%s' "$$" > "$EMULATOR_PID_FILE"
exec sleep 30
`;
  for (const [name, body] of [
    ["adb", adbStub],
    ["emulator", emulatorStub],
  ]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const oldPath = process.env.PATH;
  const previous = {};
  const values = {
    PATH: `${bin}:${oldPath ?? ""}`,
    RECORD: record,
    EMULATOR_PID_FILE: pidFile,
  };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await handleEmulatorBoot({
      avdName: "Pixel",
      headless: false,
      scale: 0.5,
      windowSize: "900x600",
      timeoutSec: 5,
      gpu: "swiftshader_indirect",
    });
    assert.equal(result.isError, false, result.content[0].text);
    const calls = readFileSync(record, "utf8").split("\n");
    const launch = calls.find((line) => line.includes("-avd Pixel"));
    assert.ok(launch, `launch line missing: ${calls.join(" | ")}`);
    assert.match(launch, /-scale 0\.5/);
    assert.match(launch, /-skin 900x600/);
    assert.doesNotMatch(launch, /-no-window/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.PATH = oldPath;
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      process.kill(pid, "SIGKILL");
    } catch {
      /* not started or already gone */
    }
    rmSync(work, { recursive: true, force: true });
  }
});

// --- window geometry tool ----------------------------------------------------
test("adb window geometry validates action, size and density", () => {
  const parsed = ToolSchemas.adbWindowGeometry.parse({
    action: "set",
    size: "1080x2400",
    density: 420,
  });
  assert.equal(parsed.action, "set");
  assert.equal(parsed.size, "1080x2400");
  assert.equal(parsed.density, 420);

  assert.throws(() => ToolSchemas.adbWindowGeometry.parse({ action: "set" }));
  assert.throws(() => ToolSchemas.adbWindowGeometry.parse({ action: "get", size: "1080x2400" }));
  assert.throws(() => ToolSchemas.adbWindowGeometry.parse({ size: "1080x2400", density: 420 }));
  assert.throws(() => ToolSchemas.adbWindowGeometry.parse({ action: "set", size: "big" }));
  assert.throws(() => ToolSchemas.adbWindowGeometry.parse({ action: "set", density: 0 }));
});

posixTest("adb window geometry reads current size and density", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "wm-get-"));
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const record = path.join(work, "record.txt");
  const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "-s" ]; then shift 2; fi
if [ "$1" = "shell" ] && [ "$2" = "wm" ]; then
  shift 2
  if [ "$1" = "size" ]; then printf 'Physical size: 1080x2400\n'; exit 0; fi
  if [ "$1" = "density" ]; then printf 'Physical density: 420\n'; exit 0; fi
fi
exit 0
`;
  writeFileSync(path.join(bin, "adb"), adbStub);
  chmodSync(path.join(bin, "adb"), 0o755);
  const previous = {};
  const values = { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: record };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await handleAdbWindowGeometry({ deviceId: "emulator-5554", action: "get" });
    assert.equal(result.isError, false, result.content[0].text);
    const text = result.content[0].text;
    assert.match(text, /status=current/);
    assert.match(text, /physicalSize=1080x2400/);
    assert.match(text, /overrideSize=none/);
    assert.match(text, /physicalDensity=420/);
    assert.match(text, /overrideDensity=none/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  }
});

posixTest("adb window geometry sets and verifies wm size and density", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "wm-set-"));
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const record = path.join(work, "record.txt");
  const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "-s" ]; then shift 2; fi
if [ "$1" = "shell" ] && [ "$2" = "wm" ]; then
  shift 2
  if [ "$1" = "size" ] && [ -n "$2" ]; then exit 0; fi
  if [ "$1" = "density" ] && [ -n "$2" ]; then exit 0; fi
  if [ "$1" = "size" ]; then printf 'Physical size: 1080x2400\nOverride size: 1080x2400\n'; exit 0; fi
  if [ "$1" = "density" ]; then printf 'Physical density: 420\nOverride density: 420\n'; exit 0; fi
fi
exit 0
`;
  writeFileSync(path.join(bin, "adb"), adbStub);
  chmodSync(path.join(bin, "adb"), 0o755);
  const previous = {};
  const values = { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: record };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await handleAdbWindowGeometry({
      deviceId: "emulator-5554",
      action: "set",
      size: "1080x2400",
      density: 420,
    });
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /status=applied/);
    const calls = readFileSync(record, "utf8");
    assert.match(calls, /shell wm size 1080x2400/);
    assert.match(calls, /shell wm density 420/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  }
});

posixTest("adb window geometry resets and verifies wm overrides", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "wm-reset-"));
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const record = path.join(work, "record.txt");
  const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "-s" ]; then shift 2; fi
if [ "$1" = "shell" ] && [ "$2" = "wm" ]; then
  shift 2
  if [ "$1" = "size" ] && [ "$2" = "reset" ]; then exit 0; fi
  if [ "$1" = "density" ] && [ "$2" = "reset" ]; then exit 0; fi
  if [ "$1" = "size" ]; then printf 'Physical size: 1080x2400\n'; exit 0; fi
  if [ "$1" = "density" ]; then printf 'Physical density: 420\n'; exit 0; fi
fi
exit 0
`;
  writeFileSync(path.join(bin, "adb"), adbStub);
  chmodSync(path.join(bin, "adb"), 0o755);
  const previous = {};
  const values = { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: record };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await handleAdbWindowGeometry({ deviceId: "emulator-5554", action: "reset" });
    assert.equal(result.isError, false, result.content[0].text);
    assert.match(result.content[0].text, /status=reset/);
    const calls = readFileSync(record, "utf8");
    assert.match(calls, /shell wm size reset/);
    assert.match(calls, /shell wm density reset/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  }
});

posixTest("adb window geometry reports a failed wm command", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "wm-fail-"));
  const bin = path.join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const record = path.join(work, "record.txt");
  const adbStub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$RECORD"
if [ "$1" = "-s" ]; then shift 2; fi
if [ "$1" = "shell" ] && [ "$2" = "wm" ]; then
  shift 2
  if [ "$1" = "size" ] && [ -n "$2" ]; then exit 1; fi
  if [ "$1" = "size" ]; then printf 'Physical size: 1080x2400\n'; exit 0; fi
  if [ "$1" = "density" ]; then printf 'Physical density: 420\n'; exit 0; fi
fi
exit 0
`;
  writeFileSync(path.join(bin, "adb"), adbStub);
  chmodSync(path.join(bin, "adb"), 0o755);
  const previous = {};
  const values = { PATH: `${bin}:${process.env.PATH ?? ""}`, RECORD: record };
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    const result = await handleAdbWindowGeometry({
      deviceId: "emulator-5554",
      action: "set",
      size: "1080x2400",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /wm size failed/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(work, { recursive: true, force: true });
  }
});
