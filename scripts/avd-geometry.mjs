#!/usr/bin/env node
// ISSUE-12 / FR-D1: detect AVD windows that cannot fit on this host.
// An emulator window needs roughly lcdHeight x displayScale host pixels; when
// that exceeds the available display height the top of the window is cropped.
// Usage:
//   node scripts/avd-geometry.mjs --check
//   node scripts/avd-geometry.mjs --suggest
//   node scripts/avd-geometry.mjs --avd-dir DIR --host-height 864 --scale 1.25 --check
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function usage(message) {
  if (message) console.error(`avd-geometry: ${message}`);
  console.error(
    "usage: avd-geometry.mjs [--check|--suggest] [--avd-dir DIR] " +
      "[--host-height PX] [--scale N]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { mode: "check", avdDir: join(homedir(), ".android", "avd") };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") opts.mode = "check";
    else if (arg === "--suggest") opts.mode = "suggest";
    else if (arg === "--avd-dir") opts.avdDir = argv[++i] ?? usage("--avd-dir needs a value");
    else if (arg === "--host-height") opts.hostHeight = argv[++i];
    else if (arg === "--scale") opts.scale = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: avd-geometry.mjs [--check|--suggest] [--avd-dir DIR] [--host-height PX] [--scale N]",
      );
      process.exit(0);
    } else usage(`unknown argument ${arg}`);
  }
  return opts;
}

function detectHostHeight() {
  const env = process.env.ANDROID_MCP_HOST_HEIGHT;
  if (env) return Number(env);
  try {
    if (process.platform === "linux") {
      const r = spawnSync("xrandr", ["--current"], { encoding: "utf8" });
      if (r.status === 0) {
        const line = r.stdout
          .split("\n")
          .find((l) => / connected( primary)? /.test(l) && /\d+x\d+\+/.test(l));
        const m = line?.match(/(\d+)x(\d+)\+/);
        if (m) return Number(m[2]);
      }
    } else if (process.platform === "darwin") {
      const r = spawnSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" });
      const m = r.status === 0 ? r.stdout.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/) : null;
      if (m) return Number(m[2]);
    } else if (process.platform === "win32") {
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_VideoController | Where-Object CurrentVerticalResolution | " +
            "Select-Object -First 1 -ExpandProperty CurrentVerticalResolution)",
        ],
        { encoding: "utf8" },
      );
      const height = Number.parseInt((r.stdout ?? "").trim(), 10);
      if (Number.isInteger(height) && height > 0) return height;
    }
  } catch {
    // Detection is best effort; the caller reports how to provide the value.
  }
  return null;
}

function readConfig(avdDir, entry) {
  const path = join(avdDir, entry, "config.ini");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const values = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2];
  }
  const width = Number.parseInt(values["hw.lcd.width"] ?? "", 10);
  const height = Number.parseInt(values["hw.lcd.height"] ?? "", 10);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  return { name: entry.replace(/\.avd$/, ""), width, height };
}

function suggestionFor(hostHeight, lcdHeight) {
  const ratio = Math.max(0.1, Math.min(1, hostHeight / lcdHeight));
  return (Math.floor(ratio * 100) / 100).toFixed(2);
}

const opts = parseArgs(process.argv.slice(2));
const hostHeightRaw = opts.hostHeight ?? null;
const hostHeight = hostHeightRaw === null ? detectHostHeight() : Number.parseInt(hostHeightRaw, 10);
const scaleRaw = opts.scale ?? process.env.ANDROID_MCP_DISPLAY_SCALE ?? "1";
const scale = Number(scaleRaw);

if (!Number.isFinite(scale) || scale < 0.1 || scale > 3) {
  usage(`invalid scale ${scaleRaw}: expected 0.1..3`);
}
if (hostHeight !== null && (!Number.isInteger(hostHeight) || hostHeight <= 0)) {
  usage(`invalid host height ${hostHeightRaw}`);
}

let entries;
try {
  entries = readdirSync(opts.avdDir)
    .filter((entry) => entry.endsWith(".avd"))
    .sort();
} catch {
  console.log(`no AVDs found in ${opts.avdDir}`);
  process.exit(0);
}
const avds = entries.map((entry) => readConfig(opts.avdDir, entry)).filter(Boolean);
if (avds.length === 0) {
  console.log(`no AVDs found in ${opts.avdDir}`);
  process.exit(0);
}
if (hostHeight === null) {
  console.log(
    "host height unknown; pass --host-height PX or set ANDROID_MCP_HOST_HEIGHT to check AVD geometry",
  );
  process.exit(0);
}

const cropped = [];
for (const avd of avds) {
  const needed = Math.round(avd.height * scale);
  if (needed > hostHeight) {
    const suggestion = suggestionFor(hostHeight, avd.height);
    cropped.push(avd.name);
    console.log(
      `WARN ${avd.name}: ${avd.width}x${avd.height} at scale ${scale.toFixed(2)} needs ` +
        `${needed} px, host height ${hostHeight} px — boot with -scale ${suggestion} ` +
        `(emulator_boot scale=${suggestion}) or apply templates/avd/high-dpi-small-host.config.ini`,
    );
  } else {
    console.log(
      `OK   ${avd.name}: ${avd.width}x${avd.height} at scale ${scale.toFixed(2)} needs ` +
        `${needed} px (host ${hostHeight} px)`,
    );
  }
}

if (opts.mode === "check" && cropped.length > 0) {
  console.log(`${cropped.length} AVD window(s) would be cropped on this host`);
  process.exit(1);
}
process.exit(0);
