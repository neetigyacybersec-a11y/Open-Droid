// ISSUE-155: export/import of reproducible, safe installation profiles.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { exportProfile, importProfile, profileDiff, validateProfile } from "../scripts/profile.mjs";
import { writeManifest } from "../scripts/installer/manifest.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "profile-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

const pins = `NODE_MAJOR=22\nGRADLE_VERSION=8.10.2\nGRADLE_SHA256=${"a".repeat(64)}\nFRIDA_VERSION=17.24.3\n`;

function fixture(name) {
  const root = join(work, name);
  const installRoot = join(root, ".toolchain");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(root, "versions.env"), pins);
  writeManifest(installRoot, {
    schema: 1,
    profile: "full",
    version: "0.1.0",
    components: {
      node: { required: true, paths: [] },
      gradle: { required: false, paths: [".toolchain/gradle"] },
      frida: { required: false, paths: [".toolchain/python-venv"] },
    },
  });
  return { root, installRoot };
}

test("export is versioned, capability-aware and free of paths or secrets", () => {
  const { root, installRoot } = fixture("export");
  const profile = exportProfile({ root, installRoot, platform: "linux" });
  assert.equal(profile.schema, 1);
  assert.equal(profile.profile, "full");
  assert.deepEqual(profile.capabilities.sort(), ["frida", "gradle"]);
  assert.equal(profile.pins.GRADLE_VERSION, "8.10.2");
  assert.match(profile.digest, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(profile);
  assert.doesNotMatch(serialized, /\/home\/|\/tmp\/|token|password|api[_-]?key/i);
  validateProfile(profile, { platform: "linux", arch: process.arch });
});

test("import validates schema, platform, capabilities and hostile fields", () => {
  const base = exportProfile({ ...fixture("validate"), platform: "linux" });
  assert.throws(() => validateProfile({ ...base, schema: 999 }), /unsupported profile version/);
  const otherOs = process.platform === "win32" ? "linux" : "win32";
  assert.throws(() => validateProfile({ ...base, platform: { os: otherOs, arch: "x64" } }), /platform mismatch/);
  assert.throws(() => validateProfile({ ...base, capabilities: ["nope"] }), /unknown capabilities/);
  assert.throws(() => validateProfile({ ...base, api_token: "x" }), /secret-like field/);
  assert.throws(() => validateProfile({ ...base, pins: { HOME: "/etc/passwd" } }), /machine-specific path/);
  assert.throws(() => validateProfile(null), /JSON object/);
});

test("import rejects malformed JSON and requires a reviewable confirmation", async () => {
  const { root, installRoot } = fixture("import");
  const file = join(root, "profile.json");
  writeFileSync(file, "{ broken");
  await assert.rejects(() => importProfile({ file, root, installRoot, platform: "linux" }), /invalid profile JSON/);
  const profile = exportProfile({ root, installRoot, platform: "linux" });
  profile.capabilities = ["gradle", "jadx"];
  profile.pins.GRADLE_VERSION = "8.11.0";
  writeFileSync(file, JSON.stringify(profile));
  const preview = await importProfile({
    file,
    root,
    installRoot,
    platform: "linux",
    install: async () => {
      throw new Error("installer must not run without confirmation");
    },
  });
  assert.equal(preview.applied, false);
  assert.match(preview.reason, /confirmation/);
  assert.ok(preview.diff.some((entry) => entry.key === "GRADLE_VERSION"));
  assert.ok(preview.diff.some((entry) => entry.key === "capability:jadx"));
});

test("confirmed import uses the normal installer with the reviewed pins", async () => {
  const { root, installRoot } = fixture("apply");
  const file = join(root, "profile.json");
  writeFileSync(file, JSON.stringify(exportProfile({ root, installRoot, platform: "linux" })));
  let seen = null;
  const result = await importProfile({
    file,
    root,
    installRoot,
    platform: "linux",
    confirm: true,
    install: async (options) => {
      seen = options;
      return { changed: true };
    },
  });
  assert.equal(result.applied, true);
  assert.equal(seen.profile, "full");
  assert.equal(seen.pins.GRADLE_VERSION, "8.10.2");
  assert.deepEqual(seen.capabilities.sort(), ["frida", "gradle"]);
  assert.equal(seen.root, installRoot);
});

test("profileDiff is symmetric for unchanged profiles", () => {
  const a = { pins: { A: "1" }, capabilities: ["x"] };
  const b = { pins: { A: "1" }, capabilities: ["x"] };
  assert.deepEqual(profileDiff(a, b), []);
});
