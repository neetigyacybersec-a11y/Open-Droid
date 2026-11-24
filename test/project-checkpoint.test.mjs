// ISSUE-51: project checkpoints and guarded restore.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  checkpointsDir,
  createCheckpoint,
  diffCheckpoint,
  listCheckpoints,
  readCheckpoint,
  restoreCheckpoint,
} from "../dist/projectCheckpoint.js";
import { TOOL_REGISTRY } from "../dist/registry.js";
import { ToolSchemas } from "../dist/tools.js";

process.env.ANDROID_MCP_CHECKPOINTS_DIR = mkdtempSync(join(tmpdir(), "od-ckpt-store-"));

afterEach(() => {
  rmSync(process.env.ANDROID_MCP_CHECKPOINTS_DIR, { recursive: true, force: true });
});

function git(dir, args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "od-ckpt-proj-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(path.includes("/") ? join(root, path.slice(0, path.lastIndexOf("/"))) : root, {
      recursive: true,
    });
    writeFileSync(join(root, path), content);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

test("createCheckpoint captures tracked and untracked files with manifest + copies", async () => {
  const root = project({ "src/A.kt": "class A\n", "README.md": "# App\n" });
  try {
    writeFileSync(join(root, "src/A.kt"), "class A {\n  fun x() {}\n}\n");
    writeFileSync(join(root, "src/B.kt"), "class B\n");
    writeFileSync(join(root, "src/C.kt"), "class C\n");
    mkdirSync(join(root, "build"), { recursive: true });
    writeFileSync(join(root, "build/output.jar"), "binary");
    const cp = await createCheckpoint({ projectPath: root, name: "ckpt-1" });
    assert.equal(cp.name, "ckpt-1");
    assert.equal(cp.baseCommit.length, 40, "base commit sha captured");
    const paths = cp.files.map((f) => f.path).sort();
    assert.ok(paths.includes("src/A.kt"), `modified tracked captured: ${paths}`);
    assert.ok(paths.includes("src/B.kt"), `tracked file captured: ${paths}`);
    assert.ok(paths.includes("src/C.kt"), `untracked captured: ${paths}`);
    assert.ok(!paths.some((p) => p.startsWith("build/")), "build outputs excluded");
    assert.ok(paths.includes("README.md"));
    assert.ok(existsSync(join(checkpointsDir(), "ckpt-1", "checkpoint.json")));
    assert.ok(existsSync(join(checkpointsDir(), "ckpt-1", "files/src/B.kt")), "file copy written");
    assert.ok(existsSync(join(checkpointsDir(), "ckpt-1", "files/src/C.kt")), "untracked file copied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createCheckpoint in a non-git project reports baseCommit null", async () => {
  const root = mkdtempSync(join(tmpdir(), "od-ckpt-nogit-"));
  try {
    writeFileSync(join(root, "notes.txt"), "hello\n");
    const cp = await createCheckpoint({ projectPath: root, name: "plain" });
    assert.equal(cp.baseCommit, null);
    assert.ok(cp.files.some((f) => f.path === "notes.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listCheckpoints returns metadata for created checkpoints", async () => {
  const root = project({ "a.txt": "a\n" });
  try {
    await createCheckpoint({ projectPath: root, name: "list-me" });
    const list = listCheckpoints();
    const entry = list.find((c) => c.name === "list-me");
    assert.ok(entry, "checkpoint listed");
    assert.ok(entry.createdAt);
    assert.ok(Array.isArray(entry.files));
    assert.ok(entry.files.length >= 1);
    assert.ok(readCheckpoint("list-me"), "readCheckpoint returns manifest");
    assert.equal(readCheckpoint("nope"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diffCheckpoint shows changed/removed files", async () => {
  const root = project({ "a.txt": "one\n", "b.txt": "two\n" });
  try {
    await createCheckpoint({ projectPath: root, name: "diff-me" });
    writeFileSync(join(root, "a.txt"), "one changed\n");
    rmSync(join(root, "b.txt"));
    const diff = diffCheckpoint({ name: "diff-me", projectPath: root });
    const a = diff.changes.find((c) => c.path === "a.txt");
    const b = diff.changes.find((c) => c.path === "b.txt");
    assert.ok(a && a.change === "changed", `a.txt changed, got ${JSON.stringify(a)}`);
    assert.ok(b && b.change === "removed", `b.txt removed, got ${JSON.stringify(b)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreCheckpoint is dry-run by default and restores on confirm", async () => {
  const root = project({ "a.txt": "one\n" });
  try {
    await createCheckpoint({ projectPath: root, name: "restore-me" });
    writeFileSync(join(root, "a.txt"), "broken\n");
    const dry = restoreCheckpoint({ name: "restore-me", dryRun: true });
    assert.equal(dry.restored, 0);
    assert.deepEqual(dry.changes, [{ path: "a.txt", change: "restore", from: "one\n" }]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "broken\n", "dry run changes nothing");
    const blocked = restoreCheckpoint({ name: "restore-me" });
    assert.equal(blocked.error, true);
    const res = restoreCheckpoint({ name: "restore-me", confirm: true });
    assert.equal(res.restored, 1);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\n", "file restored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secrets are never snapshotted and restore never touches excluded files or new files", async () => {
  const root = project({ "a.txt": "x\n" });
  try {
    writeFileSync(join(root, "local.properties"), "keystorePassword=hunter2secret\n");
    const cp = await createCheckpoint({ projectPath: root, name: "secrets-me" });
    assert.ok(!cp.files.some((f) => f.path === "local.properties"), "secret files excluded from manifest");
    writeFileSync(join(root, "unrelated-new.txt"), "user notes\n");
    writeFileSync(join(root, "local.properties"), "keystorePassword=changed-after\n");
    const diff = diffCheckpoint({ name: "secrets-me", projectPath: root });
    assert.ok(!diff.changes.some((c) => c.path === "unrelated-new.txt"), "new unrelated file not in diff");
    const restored = restoreCheckpoint({ name: "secrets-me", confirm: true });
    assert.ok(restored.changes.every((c) => c.path !== "unrelated-new.txt" && c.path !== "local.properties"), "restore only lists manifest files");
    assert.equal(readFileSync(join(root, "unrelated-new.txt"), "utf8"), "user notes\n", "unrelated new files untouched by restore");
    assert.equal(readFileSync(join(root, "local.properties"), "utf8"), "keystorePassword=changed-after\n", "excluded secret untouched by restore");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial restore only touches files that differed or were missing", async () => {
  const root = project({ "a.txt": "a\n", "b.txt": "b\n" });
  try {
    await createCheckpoint({ projectPath: root, name: "partial" });
    writeFileSync(join(root, "a.txt"), "changed\n");
    rmSync(join(root, "b.txt"));
    const res = restoreCheckpoint({ name: "partial", confirm: true });
    assert.equal(res.restored, 2);
    assert.deepEqual(res.changes.map((c) => c.path).sort(), ["a.txt", "b.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized files are reported as omitted, not silently skipped", async () => {
  const root = project({ "small.txt": "ok\n", "big.bin": "x".repeat(2 * 1024 * 1024 + 1) });
  try {
    const cp = await createCheckpoint({ projectPath: root, name: "oversized" });
    assert.deepEqual(cp.files.map((f) => f.path), ["small.txt"]);
    assert.deepEqual(cp.omittedFiles, ["big.bin"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore reports a missing snapshot copy instead of claiming success", async () => {
  const root = project({ "a.txt": "a\n", "b.txt": "b\n" });
  try {
    const cp = await createCheckpoint({ projectPath: root, name: "missing-copy" });
    rmSync(join(checkpointsDir(), cp.name, "files", "b.txt"));
    writeFileSync(join(root, "a.txt"), "changed a\n");
    writeFileSync(join(root, "b.txt"), "changed b\n");
    const res = restoreCheckpoint({ name: cp.name, confirm: true });
    assert.equal(res.restored, 1);
    assert.match(String(res.error), /missing snapshot copy/);
    assert.deepEqual(res.failed, ["b.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint names cannot escape the checkpoint store", async () => {
  const root = project({ "a.txt": "a\n" });
  const base = mkdtempSync(join(tmpdir(), "od-ckpt-escape-"));
  const previousStore = process.env.ANDROID_MCP_CHECKPOINTS_DIR;
  const store = join(base, "store");
  process.env.ANDROID_MCP_CHECKPOINTS_DIR = store;
  try {
    await assert.rejects(
      createCheckpoint({ projectPath: root, name: "../evil" }),
      /invalid checkpoint name/,
    );
    assert.equal(existsSync(join(store, "..", "evil")), false);
    assert.equal(readCheckpoint("../../x"), null);
    mkdirSync(join(store, "trusted"), { recursive: true });
    writeFileSync(
      join(store, "trusted", "checkpoint.json"),
      JSON.stringify({
        name: "../victim",
        createdAt: new Date().toISOString(),
        root,
        baseCommit: null,
        excludeDirs: [],
        files: [],
      }),
    );
    assert.deepEqual(
      listCheckpoints().map((cp) => cp.name),
      ["trusted"],
      "on-disk name is authoritative; manifest text cannot steer the store path",
    );
  } finally {
    process.env.ANDROID_MCP_CHECKPOINTS_DIR = previousStore;
    rmSync(base, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry registers android_project_checkpoint with destructive review-class policy", () => {
  const entry = TOOL_REGISTRY.find((t) => t.name === "android_project_checkpoint");
  assert.ok(entry, "android_project_checkpoint is registered");
  assert.equal(entry.risk, "destructive");
  assert.equal(entry.approval, "expert");
  assert.equal(entry.unattended, false);
  assert.ok(entry.tests.includes("test/project-checkpoint.test.mjs"));
  const schema = ToolSchemas.projectCheckpoint;
  assert.ok(schema.safeParse({ action: "list" }).success);
  assert.ok(schema.safeParse({ action: "create" }).success, "create works without name (default)");
  assert.ok(schema.safeParse({ action: "create", name: "n", projectPath: "/tmp/x" }).success);
  assert.ok(schema.safeParse({ action: "restore", name: "n", confirm: true }).success);
  assert.ok(!schema.safeParse({ action: "bogus" }).success, "invalid action rejected");
  assert.ok(!schema.safeParse({ projectPath: "/tmp/x" }).success, "action is required");
});
