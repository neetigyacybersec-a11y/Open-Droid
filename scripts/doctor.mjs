#!/usr/bin/env node
// ISSUE-19: cross-platform doctor. On Windows `make` and `scripts/doctor.sh`
// are unavailable without Git Bash/WSL2; this entry point runs everywhere Node
// runs and covers the same required-tool and android_env checks.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    [
      "android-mcp doctor (node scripts/doctor.mjs)",
      "",
      "Checks the required Android toolchain, optional dynamic-analysis tools,",
      "env vars, the MCP build, AVD window geometry and OpenCode registration.",
      "",
      "usage: node scripts/doctor.mjs [--help]",
    ].join("\n"),
  );
  process.exit(0);
}

let failed = false;
const warn = (message) => console.log(`WARN ${message}`);
const checkPath = (name) => {
  if (IS_WIN) {
    const r = spawnSync("where", [name], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
    return null;
  }
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout.split("\n").find(Boolean)?.trim() ?? null) : null;
};
const required = (name) => {
  const found = checkPath(name);
  if (found) console.log(`OK   ${name} -> ${found}`);
  else {
    console.log(`MISS ${name}`);
    failed = true;
  }
};
const optional = (name) => {
  const found = checkPath(name);
  console.log(`${found ? "OK  " : "MISS"} ${name} (optional)`);
};
const probe = (name, args) => {
  const r = spawnSync(name, args, { encoding: "utf8" });
  return r.status === 0;
};

console.log("== android-mcp doctor (android_env) ==");
const envFile = join(ROOT, ".toolchain", "env.sh");
if (existsSync(envFile)) {
  console.log(
    "toolchain env: present (source it in Git Bash, or set ANDROID_HOME/JAVA_HOME yourself)",
  );
} else {
  warn("toolchain env: NOT FOUND (run 'make setup' in Git Bash/WSL2, or 'bash scripts/setup.sh')");
}

for (const name of ["node", "java", "javac"]) required(name);
for (const name of ["gradle", "adb", "emulator", "sdkmanager", "avdmanager"]) required(name);
if (checkPath("maestro")) console.log("OK   maestro");
else console.log("MISS maestro");

for (const name of ["compose-preview", "android"]) optional(name);
for (const name of ["frida", "frida-ps", "mitmdump"]) {
  const found = checkPath(name);
  if (found) console.log(`OK   ${name} (dynamic) -> ${found}`);
  else warn(`${name} missing (optional; dynamic analysis unavailable)`);
}
if (probe("python3", ["-c", "import sys"])) console.log("OK   python3 (dynamic)");
else warn("python3 missing or not runnable (Windows Store stub?) — dynamic analysis unavailable");

const fridaDir = join(ROOT, ".toolchain", "frida");
try {
  const binaries = readdirSync(fridaDir).filter(
    (name) => name.startsWith("frida-server-") && !name.endsWith(".xz"),
  );
  if (binaries.length > 0) console.log("OK   frida-server binaries present");
  else warn("frida-server binaries missing (dynamic analysis unavailable)");
} catch {
  warn("frida-server binaries missing (dynamic analysis unavailable)");
}

for (const name of ["ANDROID_HOME", "JAVA_HOME", "GRADLE_USER_HOME"]) {
  console.log(`${name}=${process.env[name] ?? "unset"}`);
}
const npmVersion = spawnSync(IS_WIN ? "npm.cmd" : "npm", ["-v"], { encoding: "utf8" });
console.log(`node=${process.version}  npm=${(npmVersion.stdout ?? "").trim() || "unavailable"}`);

if (existsSync(join(ROOT, "dist", "index.js"))) console.log("MCP build: present");
else {
  console.log("MCP build: MISSING (run 'node scripts/build.mjs' or 'npm run build')");
  failed = true;
}

if (existsSync(join(ROOT, ".toolchain", "android-skills", ".git"))) {
  console.log("OK   android/skills: cloned");
} else {
  console.log("android/skills: not cloned (optional)");
}

if (checkPath("emulator")) {
  const avds = spawnSync("emulator", ["-list-avds"], { encoding: "utf8" });
  const list = (avds.stdout ?? "").split(/\r?\n/).filter(Boolean);
  if (list.length > 0) console.log(`AVDs: ${list.join(" ")}`);
  else warn("No AVDs found (run setup, or avdmanager create avd ...)");
}

// ISSUE-12: warn when an AVD window cannot fit this display.
const geometry = spawnSync(
  process.execPath,
  [join(ROOT, "scripts", "avd-geometry.mjs"), "--check"],
  { encoding: "utf8" },
);
process.stdout.write(geometry.stdout ?? "");
if (geometry.status === 1) {
  warn(
    "AVD window may be cropped; boot with emulator_boot scale/windowSize, or apply " +
      "templates/avd/high-dpi-small-host.config.ini",
  );
} else if (geometry.status !== 0) {
  warn(`AVD geometry check failed: ${(geometry.stderr ?? "").trim() || "unknown error"}`);
}

const opencodeConfigs = [
  join(homedir(), ".config", "opencode", "opencode.jsonc"),
  join(homedir(), ".config", "opencode", "opencode.json"),
];
const registered = opencodeConfigs.some((file) => {
  try {
    return readFileSync(file, "utf8").includes('"android-mcp"');
  } catch {
    return false;
  }
});
if (registered) console.log("OK   opencode: android-mcp registered (global)");
else warn("opencode: android-mcp NOT registered globally (run 'make register' or add it manually)");

process.exit(failed ? 1 : 0);
