// ISSUE-154: uninstall removes only manifest-owned resources.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { executeUninstall, planUninstall } from "../scripts/uninstall.mjs";
import { writeManifest } from "../scripts/installer/manifest.mjs";
import { registerClient } from "../scripts/clients.mjs";

const REPO = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "uninstall-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

function fixture(name) {
  const root = join(work, name, "repo");
  const installRoot = join(root, ".toolchain");
  mkdirSync(join(installRoot, "gradle", "bin"), { recursive: true });
  mkdirSync(join(root, "projects", "my-app"), { recursive: true });
  writeFileSync(join(installRoot, "gradle", "bin", "gradle"), "owned");
  writeFileSync(join(root, "projects", "my-app", "Main.kt"), "user work");
  writeManifest(installRoot, {
    schema: 1,
    profile: "core",
    components: {
      gradle: { required: true, paths: [".toolchain/gradle"] },
      evil: { required: false, paths: ["../projects/my-app", "/etc/passwd"] },
    },
  });
  return { root, installRoot };
}

test("dry-run lists exact paths and preserves user projects", () => {
  const { root, installRoot } = fixture("dry");
  const report = executeUninstall({ root: installRoot, project: root, home: join(work, "dry-home") });
  assert.equal(report.dryRun, true);
  assert.equal(report.deleted.length, 1);
  assert.match(report.deleted[0].path, /gradle$/);
  assert.equal(existsSync(join(root, "projects", "my-app", "Main.kt")), true);
  assert.ok(report.deleted.every((entry) => !entry.path.includes("my-app")));
});

test("apply removes owned files only and can retain categories", () => {
  const { root, installRoot } = fixture("apply");
  const kept = executeUninstall({
    root: installRoot,
    project: root,
    home: join(work, "apply-home"),
    keep: ["toolchain"],
    dryRun: false,
    yes: true,
  });
  assert.equal(kept.deleted.length, 0);
  assert.ok(kept.retained.length > 0);
  assert.equal(existsSync(join(installRoot, "gradle", "bin", "gradle")), true);
  const removed = executeUninstall({
    root: installRoot,
    project: root,
    home: join(work, "apply-home"),
    dryRun: false,
    yes: true,
  });
  assert.equal(removed.deleted.length, 1);
  assert.equal(existsSync(join(installRoot, "gradle")), false);
  assert.equal(existsSync(join(root, "projects", "my-app", "Main.kt")), true);
});

test("missing or corrupt manifests are conservative", () => {
  const root = join(work, "conservative");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "install-manifest.json"), "{ broken");
  const report = planUninstall({ root, home: join(work, "c-home") });
  assert.equal(report.conservative, true);
  assert.equal(report.deleted.length, 0);
  assert.match(report.skipped[0].reason, /manifest/);
});

test("symlinks are never followed", () => {
  const { root, installRoot } = fixture("symlink");
  const link = join(installRoot, "linked");
  try {
    symlinkSync(join(root, "projects"), link, "dir");
  } catch {
    return; // symlink creation may be restricted on the host
  }
  const manifest = JSON.parse(readFileSync(join(installRoot, "install-manifest.json"), "utf8"));
  manifest.components.linked = { required: false, paths: [".toolchain/linked"] };
  writeManifest(installRoot, manifest);
  const report = planUninstall({ root: installRoot, project: root, home: join(work, "s-home") });
  assert.ok(report.skipped.some((entry) => /symlink/.test(entry.reason)));
});

test("registration entries are reported and removed with the manifest", () => {
  const { root, installRoot } = fixture("registration");
  const home = join(work, "reg-home");
  const options = { home, project: root, skillsSource: join(REPO, "skills") };
  registerClient("opencode", options);
  const report = planUninstall({ root: installRoot, project: root, home });
  assert.ok(report.registrations.some((entry) => entry.client === "opencode"));
  const applied = executeUninstall({ root: installRoot, project: root, home, dryRun: false, yes: true });
  assert.ok(applied.registrations[0].removed, true);
  assert.doesNotMatch(readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8"), /"android-mcp"/);
});

test("uninstall source never uses destructive Git operations", () => {
  const source = readFileSync(join(REPO, "scripts", "uninstall.mjs"), "utf8");
  assert.doesNotMatch(source, /git\s+(reset|clean|checkout)|rm\s+-rf\s+~\//i);
});
