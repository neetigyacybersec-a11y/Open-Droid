// ISSUE-24: MCP clients cache tools/list, so a server that is upgraded while
// the client keeps running exposes a stale tool list. android_env_check must
// report the loaded build and whether the on-disk build changed after startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { readBuildIdentity, checkRestartRequired } = await import("../dist/buildInfo.js");
const { handleEnvCheck } = await import("../dist/tools.js");

function makeBuild({ version = "0.1.0", name = "android-mcp", files = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "build-info-"));
  const moduleDir = path.join(root, "dist");
  mkdirSync(moduleDir);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version }));
  let mtime = 1_700_000_000;
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(moduleDir, file);
    writeFileSync(target, body);
    utimesSync(target, mtime, mtime);
    mtime += 10;
  }
  return { root, moduleDir };
}

test("readBuildIdentity reads package.json and fingerprints the running modules", () => {
  const build = makeBuild({
    version: "1.2.3",
    files: { "index.js": "console.log(1);", "tools.js": "export {};" },
  });
  try {
    const identity = readBuildIdentity(build.moduleDir);
    assert.equal(identity.name, "android-mcp");
    assert.equal(identity.version, "1.2.3");
    assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(identity.builtAt, new Date(1_700_000_010_000).toISOString());

    const again = readBuildIdentity(build.moduleDir);
    assert.equal(again.fingerprint, identity.fingerprint, "the fingerprint is deterministic");

    writeFileSync(path.join(build.moduleDir, "tools.js"), "export const changed = true;");
    const changed = readBuildIdentity(build.moduleDir);
    assert.notEqual(
      changed.fingerprint,
      identity.fingerprint,
      "a rebuilt module changes the fingerprint",
    );
  } finally {
    rmSync(build.root, { recursive: true, force: true });
  }
});

test("readBuildIdentity survives a missing manifest and empty build directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-info-empty-"));
  try {
    const identity = readBuildIdentity(path.join(root, "dist"));
    assert.equal(identity.version, "unknown");
    assert.equal(identity.name, "android-mcp");
    assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkRestartRequired is quiet for the same build and precise otherwise", () => {
  const base = {
    name: "android-mcp",
    version: "0.1.0",
    fingerprint: "a".repeat(64),
    builtAt: "2026-01-01T00:00:00.000Z",
  };
  const same = checkRestartRequired(base, { ...base });
  assert.equal(same.required, false);
  assert.deepEqual(same.reasons, []);
  assert.equal(same.instruction, "");

  const upgraded = checkRestartRequired(base, { ...base, version: "0.2.0" });
  assert.equal(upgraded.required, true);
  assert.match(upgraded.reasons.join("; "), /0\.1\.0 -> 0\.2\.0/);
  assert.match(upgraded.instruction, /restart the MCP client/i);

  const rebuilt = checkRestartRequired(base, { ...base, fingerprint: "b".repeat(64) });
  assert.equal(rebuilt.required, true);
  assert.match(rebuilt.reasons.join("; "), /on-disk build changed/i);
});

test("android_env_check reports the loaded build and restart status (ISSUE-24)", async () => {
  const result = await handleEnvCheck();
  const text = result.content[0].text;
  assert.match(text, /^server: android-mcp \S+ \(pid \d+, started .+\)$/m);
  assert.match(text, /^server build: [0-9a-f]{12} \(newest module .+\)$/m);
  assert.match(text, /^on-disk build: [0-9a-f]{12} \(version \S+\)$/m);
  assert.match(text, /^restart required: no\b/m);
  assert.match(text, /tools\/list/i, "the output explains the client-side tool cache");
});
