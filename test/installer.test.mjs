// ISSUE-148/149: the installer resolves an explicit plan, installs only
// owned components, and is idempotent under a repeated run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ownedPath, ownedPaths, readManifest } from "../scripts/installer/manifest.mjs";
import { formatPlan, resolvePlan } from "../scripts/installer/profiles.mjs";
import {
  checkDiskSpace,
  downloadArtifact,
  InstallLock,
  recoverInstallation,
} from "../scripts/installer/transaction.mjs";
import { runInstall } from "../scripts/install.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "installer-"));
test.after(() => rmSync(work, { recursive: true, force: true }));
const pins = {
  NODE_MAJOR: "22",
  JAVA_MAJOR: "21",
  NODE_VERSION: "22.18.0",
  GRADLE_VERSION: "8.10.2",
  GRADLE_SHA256: "a".repeat(64),
  JADX_VERSION: "1.5.7",
  JADX_SHA256: "b".repeat(64),
  APKTOOL_VERSION: "3.0.3",
  APKTOOL_SHA256: "c".repeat(64),
  COMPOSE_PREVIEW_VERSION: "2.103.1",
  COMPOSE_PREVIEW_SHA256: "d".repeat(64),
  MAESTRO_VERSION: "cli-2.12.1",
  MAESTRO_SHA256: "e".repeat(64),
  FRIDA_VERSION: "17.24.3",
  FRIDA_TOOLS_VERSION: "14.11.0",
  MITMPROXY_VERSION: "12.3.1",
  FRIDA_SERVER_X86_64_SHA256: "f".repeat(64),
  FRIDA_SERVER_ARM64_SHA256: "0".repeat(64),
  ANDROID_CLI_URL: "https://example.test/android",
};

test("profiles resolve every dependency explicitly, including unavailable optional ones", () => {
  const core = resolvePlan({ profile: "core", pins, root: work });
  assert.deepEqual(
    core.components.map((c) => c.id),
    ["node", "java", "android-sdk", "mcp"],
  );
  assert.ok(core.components.every((c) => c.required));
  const full = resolvePlan({ profile: "full", pins, root: work, platform: "win32" });
  assert.ok(full.components.some((c) => c.id === "gradle" && c.required === false));
  assert.equal(full.components.find((c) => c.id === "android_cli").status, "unavailable");
  assert.match(formatPlan(full), /UNAVAILABLE: android_cli/);
  const custom = resolvePlan({
    profile: "custom",
    capabilities: ["no-core", "jadx"],
    pins,
    root: work,
  });
  assert.deepEqual(
    custom.components.map((c) => c.id),
    ["jadx"],
  );
  assert.throws(
    () => resolvePlan({ profile: "custom", capabilities: ["nope"], pins, root: work }),
    /unknown capabilities: nope/,
  );
});

test("manifest ownership refuses traversal and absolute paths", () => {
  const manifest = {
    schema: 1,
    components: {
      gradle: { paths: [".toolchain/gradle"] },
      bad: { paths: ["../outside", "/etc/passwd"] },
    },
  };
  const owned = ownedPaths(manifest, work);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].absolute, join(work, ".toolchain/gradle"));
  assert.throws(() => ownedPath(work, "a/../../b"), /escapes/);
});

function fetchOf(bytes) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return new Response(bytes, { status: 200 });
  };
  fn.calls = () => calls;
  return fn;
}

test("a clean install writes a manifest; a rerun reuses the verified artifact", async () => {
  const root = join(work, "clean");
  const bytes = Buffer.from("fake apktool jar");
  const localPins = { ...pins, APKTOOL_SHA256: createHash("sha256").update(bytes).digest("hex") };
  const fetchImpl = fetchOf(bytes);
  const exec = () => "";
  const options = {
    root,
    profile: "custom",
    capabilities: ["no-core", "apktool"],
    pins: localPins,
    fetchImpl,
    exec,
  };
  const dry = await runInstall({ ...options, dryRun: true });
  assert.equal(dry.changed, false);
  assert.equal(existsSync(root), false);
  const first = await runInstall(options);
  assert.equal(first.changed, true);
  assert.equal(fetchImpl.calls(), 1);
  const installed = join(root, ".toolchain/apktool/apktool.jar");
  assert.equal(readFileSync(installed, "utf8"), bytes.toString());
  const manifest = readManifest(root);
  assert.equal(manifest.profile, "custom");
  assert.match(manifest.components.apktool.paths[0], /apktool\.jar$/);
  const second = await runInstall(options);
  assert.equal(fetchImpl.calls(), 1, "verified artifact must be reused");
  assert.equal(second.components.apktool.reused, true);
  assert.equal(existsSync(installed), true);
});

test("a corrupt download is quarantined and never published", async () => {
  const root = join(work, "corrupt");
  const dest = join(root, "archive.bin");
  const bad = fetchOf(Buffer.from("not the expected bytes"));
  await assert.rejects(
    () =>
      downloadArtifact({
        url: "https://example.test/a.bin",
        sha256: "a".repeat(64),
        dest,
        fetchImpl: bad,
      }),
    /checksum mismatch/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.quarantine`), true);
});

test("a resumable download keeps valid bytes across an interrupted response", async () => {
  const root = join(work, "resume");
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from("resumable payload");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dest = join(root, "payload.bin");
  writeFileSync(`${dest}.resume`, `${JSON.stringify({ url: "u", sha256, bytes: 5 })}\n`);
  writeFileSync(`${dest}.part`, bytes.subarray(0, 5));
  let range = null;
  const fetchImpl = async (_url, options) => {
    range = options.headers?.Range;
    return new Response(bytes.subarray(5), { status: 206 });
  };
  const size = await downloadArtifact({ url: "u", sha256, dest, fetchImpl });
  assert.equal(range, "bytes=5-");
  assert.equal(size, bytes.length);
  assert.equal(readFileSync(dest, "utf8"), bytes.toString());
});

test("a transient network failure never publishes an artifact; rerun restarts safely", async () => {
  const root = join(work, "transient");
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from("eventually available");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dest = join(root, "payload.bin");
  let attempt = 0;
  const fetchImpl = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("network reset");
    return new Response(bytes, { status: 200 });
  };
  await assert.rejects(() => downloadArtifact({ url: "u", sha256, dest, fetchImpl }), /network reset/);
  assert.equal(existsSync(dest), false);
  await downloadArtifact({ url: "u", sha256, dest, fetchImpl });
  assert.equal(readFileSync(dest, "utf8"), bytes.toString());
});

test("recovery restores a last-known-good component after an interrupted activation", () => {
  const root = join(work, "recover");
  const target = join(root, ".toolchain", "gradle");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "healthy"), "ok");
  const lock = new InstallLock(root);
  lock.acquire();
  const backup = join(root, ".install-backup", "gradle");
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "healthy"), "ok");
  writeFileSync(`${backup}.target`, ".toolchain/gradle\n");
  rmSync(target, { recursive: true, force: true });
  lock.release();
  writeFileSync(join(root, ".install.lock"), "999999\n");
  const result = recoverInstallation(root);
  assert.deepEqual(result.restored, ["gradle"]);
  assert.equal(readFileSync(join(target, "healthy"), "utf8"), "ok");
});

test("the lock rejects a live installer and recovery clears a dead one", () => {
  const root = join(work, "locked");
  const lock = new InstallLock(root);
  lock.acquire();
  assert.throws(() => new InstallLock(root).acquire(), /another installer is running/);
  lock.release();
  writeFileSync(join(root, ".install.lock"), "999999\n");
  mkdirSync(join(root, ".install-staging"), { recursive: true });
  writeFileSync(join(root, ".install-staging", "junk"), "x");
  const recovered = recoverInstallation(root);
  assert.equal(existsSync(join(root, ".install.lock")), false);
  assert.equal(recovered.stagingRemoved, true);
});

test("disk checks use the filesystem and report shortfalls before mutation", () => {
  const free = checkDiskSpace(work, 0);
  assert.ok(free > 0);
  assert.throws(() => checkDiskSpace(work, free * 4), /insufficient disk space/);
});
