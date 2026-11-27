// ISSUE-153: generations restore owned runtime files, never user data or Git state.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createGeneration, listGenerations, rollbackGeneration, verifyGeneration } from "../scripts/generations.mjs";
import * as generations from "../scripts/generations.mjs";
import { writeManifest } from "../scripts/installer/manifest.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "generations-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

function fixture(root) {
  mkdirSync(join(root, ".toolchain", "gradle"), { recursive: true });
  mkdirSync(join(root, "projects", "my-app"), { recursive: true });
  writeFileSync(join(root, ".toolchain", "gradle", "healthy"), "v1");
  writeFileSync(join(root, "projects", "my-app", "Main.kt"), "user work");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "entry-v1");
  writeFileSync(join(root, "dist", "extra.js"), "module-v1");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "dep-v1");
  writeManifest(join(root, ".toolchain"), {
    schema: 1,
    profile: "core",
    version: "1.0.0",
    components: {
      gradle: { required: true, paths: [".toolchain/gradle"] },
      mcp: { required: true, paths: ["dist", "node_modules"] },
    },
  });
}

test("create, verify and roll back a generation without touching user files", () => {
  const root = join(work, "rollback");
  fixture(root);
  const generation = createGeneration(join(root, ".toolchain"), { mode: "source", reason: "pre-update" });
  assert.equal(generation.mode, "source");
  assert.equal(listGenerations(join(root, ".toolchain")).length, 1);
  writeFileSync(join(root, ".toolchain", "gradle", "healthy"), "v2-broken");
  const verified = verifyGeneration(join(root, ".toolchain"), generation.id);
  assert.equal(verified.verified, true);
  const result = rollbackGeneration(join(root, ".toolchain"), { id: generation.id, verify: false });
  assert.equal(result.restored[0], join(".toolchain", "gradle"));
  assert.equal(readFileSync(join(root, ".toolchain", "gradle", "healthy"), "utf8"), "v1");
  assert.equal(readFileSync(join(root, "projects", "my-app", "Main.kt"), "utf8"), "user work");
  const history = readFileSync(join(root, ".toolchain", "generations", "rollback-history.jsonl"), "utf8");
  assert.match(history, /generation-created/);
  assert.match(history, /rollback/);
});

test("a generation restores partial dist output and node_modules (issue 176)", () => {
  const root = join(work, "mcp-runtime");
  fixture(root);
  const generation = createGeneration(join(root, ".toolchain"), {
    mode: "source",
    reason: "pre-update",
    sourceCommit: "abc123",
  });
  assert.deepEqual(
    generation.paths.map((entry) => entry.relative.split("\\").join("/")).sort(),
    [".toolchain/gradle", "dist", "node_modules"],
  );
  const state = JSON.parse(
    readFileSync(join(root, ".toolchain", "generations", generation.id, "state.json"), "utf8"),
  );
  assert.equal(state.sourceCommit, "abc123");
  rmSync(join(root, "dist", "extra.js"));
  rmSync(join(root, "node_modules", "dep"), { recursive: true, force: true });
  writeFileSync(join(root, "dist", "index.js"), "broken");
  const result = rollbackGeneration(join(root, ".toolchain"), { id: generation.id });
  assert.equal(readFileSync(join(root, "dist", "extra.js"), "utf8"), "module-v1");
  assert.equal(readFileSync(join(root, "dist", "index.js"), "utf8"), "entry-v1");
  assert.equal(readFileSync(join(root, "node_modules", "dep", "index.js"), "utf8"), "dep-v1");
  assert.ok(result.restored.includes("dist"));
  assert.ok(result.restored.includes("node_modules"));
  assert.ok(result.doctor, "rollback reports doctor health");
});

test("a legacy manifest still snapshots the complete MCP runtime (issue 176)", () => {
  const root = join(work, "legacy-manifest");
  fixture(root);
  const manifestFile = join(root, ".toolchain", "install-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.components.mcp.paths = ["dist/index.js"];
  writeManifest(join(root, ".toolchain"), manifest);

  const generation = createGeneration(join(root, ".toolchain"), { mode: "source" });
  assert.deepEqual(
    generation.paths.map((entry) => entry.relative.split("\\").join("/")).sort(),
    [".toolchain/gradle", "dist", "node_modules"],
  );
  rmSync(join(root, "dist", "extra.js"));
  rmSync(join(root, "node_modules", "dep"), { recursive: true, force: true });
  const result = rollbackGeneration(join(root, ".toolchain"), { id: generation.id });
  assert.equal(readFileSync(join(root, "dist", "extra.js"), "utf8"), "module-v1");
  assert.equal(readFileSync(join(root, "node_modules", "dep", "index.js"), "utf8"), "dep-v1");
  assert.ok(result.restored.includes("dist") && result.restored.includes("node_modules"));
});

test("an absent manifest cannot create a rollback snapshot", () => {
  const root = join(work, "no-manifest");
  mkdirSync(join(root, ".toolchain"), { recursive: true });
  assert.throws(() => createGeneration(join(root, ".toolchain")), /no install manifest/);
});

test("unknown and corrupt generations are refused", () => {
  const root = join(work, "corrupt-generation");
  fixture(root);
  const generation = createGeneration(join(root, ".toolchain"));
  assert.throws(
    () => rollbackGeneration(join(root, ".toolchain"), { id: "missing", verify: false }),
    /unknown generation/,
  );
  const dir = join(root, ".toolchain", "generations", generation.id);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  state.paths.push({ id: "evil", relative: "../../outside", name: "x" });
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(state)}\n`);
  assert.throws(
    () => rollbackGeneration(join(root, ".toolchain"), { id: generation.id, verify: false }),
    /escapes installation root/,
  );
});

test("generation containment rejects cross-drive and UNC Windows targets (audit 2)", () => {
  assert.equal(generations.escapesRoot?.("C:\\repo", "D:\\evil", "win32"), true);
  assert.equal(generations.escapesRoot?.("C:\\repo", "\\\\server\\share\\evil", "win32"), true);
  assert.equal(generations.escapesRoot?.("C:\\repo", "C:\\repo\\dist", "win32"), false);
  assert.equal(generations.escapesRoot?.("/repo", "/outside", "posix"), true);
  assert.equal(generations.escapesRoot?.("/repo", "/repo/dist", "posix"), false);
});

test("no generation path performs destructive Git operations", () => {
  for (const name of ["scripts/generations.mjs", "scripts/update.mjs"]) {
    const source = readFileSync(join(REPO, name), "utf8");
    assert.doesNotMatch(source, /git\s+(reset|rebase)|--hard|push\s+(--force|-f)\b/i, name);
  }
  const update = readFileSync(join(REPO, "scripts", "update.mjs"), "utf8");
  assert.match(update, /createGeneration/);
  assert.match(update, /rollbackGeneration/);
});
