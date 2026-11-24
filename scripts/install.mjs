#!/usr/bin/env node
// ISSUE-148/149: first-party, cross-platform installer. One plan -> one locked
// transaction -> one ownership manifest. Node is the only runtime prerequisite;
// PowerShell and POSIX bootstraps download a pinned Node if needed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractArchive, extractXz } from "./installer/archive.mjs";
import { resolveJdk } from "./installer/jdk.mjs";
import { digestFile, newManifest, readManifest, writeManifest } from "./installer/manifest.mjs";
import {
  formatPlan,
  readPins,
  resolvePlan,
} from "./installer/profiles.mjs";
import {
  activateComponent,
  checkDiskSpace,
  downloadArtifact,
  InstallLock,
  recoverInstallation,
  STAGING,
} from "./installer/transaction.mjs";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    input: options.input,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})`);
  }
  return result.stdout || result.stderr || "";
}

function requiredAvailable(plan) {
  const missing = plan.components.filter(
    (component) => component.required && component.status !== "available",
  );
  if (missing.length > 0) {
    throw new Error(`required dependencies unavailable: ${missing.map((c) => c.id).join(", ")}`);
  }
}

function majorOf(text) {
  const match = /(?:^|\D)(\d{2,3})(?:\.|\D|$)/.exec(text ?? "");
  return match ? Number(match[1]) : 0;
}

/** Reuse a compatible host JDK, otherwise install a checksummed Temurin build. */
async function installJdk(component, context) {
  const { root, exec } = context;
  const probe = exec(component.probe.split(" ")[0], component.probe.split(" ").slice(1), {
    stdio: "pipe",
  });
  if (majorOf(probe) >= Number(component.min)) {
    return { version: probe.trim().split("\n")[0], reused: true };
  }
  const jdk = await resolveJdk({ major: Number(component.min), fetchImpl: context.fetchImpl });
  const cache = join(root, ".install-cache", "jdk");
  const archive = join(cache, basename(new URL(jdk.url).pathname));
  if (!(existsSync(archive) && digestFile(archive) === jdk.sha256)) {
    await downloadArtifact({ url: jdk.url, sha256: jdk.sha256, dest: archive, fetchImpl: context.fetchImpl });
  }
  const staged = join(root, STAGING, "jdk");
  extractArchive({ archive, dest: staged, strip: 1 });
  activateComponent(root, "java", staged, component.path);
  return { version: jdk.version, reused: false, sha256: jdk.sha256, url: jdk.url };
}

/** Install the SDK natively (no shell) via the versioned command-line tools. */
async function installSdk(component, context) {
  const { root, exec, fetchImpl, previous } = context;
  const cache = join(root, ".install-cache", "android-sdk");
  const url = `https://dl.google.com/android/repository/commandlinetools-linux-${component.cmdlineToolsVersion}_latest.zip`;
  const archive = join(cache, basename(url));
  // Google publishes no digest. Pin the first verified download in the
  // manifest; later installs refuse a changed artifact.
  const expected = previous?.components?.["android-sdk"]?.sha256;
  if (existsSync(archive) && expected && digestFile(archive) !== expected) {
    throw new Error("Android command-line tools digest changed; refusing to install");
  }
  if (!existsSync(archive)) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`SDK download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(cache, { recursive: true });
    writeFileSync(archive, bytes);
  }
  const sha256 = digestFile(archive);
  if (expected && sha256 !== expected) throw new Error("Android command-line tools checksum mismatch");
  const staged = join(root, STAGING, "android-sdk");
  extractArchive({ archive, dest: staged, strip: 0 });
  const tools = join(staged, "cmdline-tools", "latest", "bin");
  const sdkRoot = join(staged, "sdk");
  const manager = process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };
  exec(join(tools, manager), ["--licenses", `--sdk_root=${sdkRoot}`], {
    env,
    input: `${"y\n".repeat(40)}`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  exec(join(tools, manager), [
    `--sdk_root=${sdkRoot}`,
    "--install",
    "platform-tools",
    `platforms;${component.platform}`,
    `build-tools;${component.buildTools}`,
  ], { env });
  activateComponent(root, "android-sdk", staged, component.path);
  return { version: component.cmdlineToolsVersion, reused: false, sha256 };
}

async function installComponent(component, context) {
  const { root, exec, fetchImpl } = context;
  const cache = join(root, ".install-cache", component.id);
  const staged = join(root, STAGING, component.id);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  if (component.kind === "existing") {
    const version = exec(component.probe.split(" ")[0], component.probe.split(" ").slice(1), {
      stdio: "pipe",
    });
    return { version: version.trim().split("\n")[0], reused: true };
  }
  if (component.kind === "jdk") return installJdk(component, context);
  if (component.kind === "sdk") return installSdk(component, context);
  if (component.kind === "builtin") {
    if (existsSync(join(REPO, "dist", "index.js")) && context.reuseBuilt) {
      return { version: "reused", reused: true };
    }
    exec(context.npm, ["ci"], { cwd: REPO });
    exec(context.npm, ["run", "build"], { cwd: REPO });
    return { version: "built", reused: false };
  }
  if (component.kind === "venv") {
    exec("python3", ["-m", "venv", staged]);
    exec(join(staged, "bin", "python"), ["-m", "pip", "install", "--quiet", ...component.packages]);
    activateComponent(root, component.id, staged, component.path);
    return { version: component.version, reused: false };
  }
  if (component.kind === "download") {
    const url = component.url;
    const archive = join(cache, basename(new URL(url).pathname));
    let reused = false;
    if (existsSync(archive) && digestFile(archive) === component.sha256) reused = true;
    else await downloadArtifact({ url, sha256: component.sha256, dest: archive, fetchImpl });
    extractArchive({ archive, dest: staged, strip: component.strip ?? 0 });
    const source = component.archive === "copy" ? join(staged, basename(archive)) : staged;
    activateComponent(root, component.id, source, component.path);
    return { version: component.version, reused, sha256: digestFile(archive) };
  }
  if (component.kind === "download-set") {
    for (const asset of component.assets) {
      const archive = join(cache, basename(new URL(asset.url).pathname));
      if (!(existsSync(archive) && digestFile(archive) === asset.sha256)) {
        await downloadArtifact({ url: asset.url, sha256: asset.sha256, dest: archive, fetchImpl });
      }
      const name = basename(new URL(asset.url).pathname).replace(/\.xz$/, "");
      extractXz({ archive, dest: join(staged, name) });
    }
    activateComponent(root, component.id, staged, component.path);
    return { version: component.version, reused: false };
  }
  if (component.kind === "external") {
    return { version: component.version, reused: false, setup: component.setup };
  }
  if (component.kind === "managed") {
    if (process.platform === "win32") {
      return { version: null, reused: false, unavailable: "managed setup needs a POSIX shell" };
    }
    exec("bash", [join(REPO, "scripts", "setup.sh")], { cwd: REPO });
    return { version: "managed", reused: false };
  }
  return { version: null, reused: false, unavailable: `unsupported component kind: ${component.kind}` };
}

/** Resolve, apply and record one install transaction. */
export async function runInstall({
  root = resolve(REPO, ".toolchain"),
  profile = "core",
  capabilities = [],
  dryRun = false,
  reuseBuilt = true,
  npm = process.platform === "win32" ? "npm.cmd" : "npm",
  exec = defaultExec,
  fetchImpl = globalThis.fetch,
  pins = readPins(REPO),
  platform = process.platform,
} = {}) {
  const plan = resolvePlan({ profile, capabilities, root, pins, platform });
  if (dryRun) return { plan, changed: false, components: {} };
  requiredAvailable(plan);
  const previous = readManifest(root);
  const lock = new InstallLock(root);
  lock.acquire();
  try {
    const recovery = recoverInstallation(root);
    const estimate = plan.components
      .filter((component) => component.kind === "download" || component.kind === "download-set")
      .reduce((sum) => sum + 600 * 1024 * 1024, 512 * 1024 * 1024);
    checkDiskSpace(root, estimate);
    const components = {};
    for (const component of plan.components) {
      if (component.status !== "available") continue;
      components[component.id] = await installComponent(component, {
        root,
        exec,
        fetchImpl,
        reuseBuilt: reuseBuilt && previous !== null,
        npm,
        previous,
      });
    }
    const manifest = newManifest(plan, { previousProfile: previous?.profile ?? null });
    manifest.components = Object.fromEntries(
      Object.entries(manifest.components).map(([id, entry]) => [
        id,
        { ...entry, ...(components[id] ?? {}) },
      ]),
    );
    writeManifest(root, manifest);
    return { plan, changed: true, components, recovery, manifest };
  } finally {
    lock.release();
    rmSync(join(root, STAGING), { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    profile: value("--profile") ?? "core",
    capabilities: (value("--capabilities") ?? "").split(",").filter(Boolean),
    root: value("--root"),
    dryRun: argv.includes("--dry-run") || argv.includes("--plan"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = await runInstall({ ...args, root: args.root ? resolve(args.root) : resolve(REPO, ".toolchain") });
  console.log(formatPlan(result.plan));
  if (result.changed) console.log(`install manifest: ${join(result.manifest ? args.root ?? resolve(REPO, ".toolchain") : "", "install-manifest.json")}`);
  else console.log("dry run only; nothing was installed");
}
