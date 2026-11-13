// FR-B1 / ISSUE-13: a scaffold without sdk.dir cannot build ("SDK location not found").
// new-app.sh must write local.properties when ANDROID_HOME is set and fail loudly when not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

function scaffold(name, envOverrides) {
  const env = { ...process.env, ...envOverrides };
  delete env.ANDROID_SDK_ROOT; // script must depend on ANDROID_HOME only
  return spawnSync("bash", ["scripts/new-app.sh", name], {
    cwd: REPO,
    env,
    encoding: "utf8",
  });
}

test("fresh scaffold writes local.properties with sdk.dir from ANDROID_HOME", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newapp-t1-"));
  const sdk = mkdtempSync(path.join(tmpdir(), "fake-sdk-"));
  const app = `${work}/demo`;
  try {
    const r = scaffold(app, { ANDROID_HOME: sdk });
    assert.equal(r.status, 0, `scaffold failed: ${r.stderr}`);
    const lp = readFileSync(path.join(app, "local.properties"), "utf8");
    assert.match(lp, /^sdk\.dir=/, "local.properties must set sdk.dir");
    assert.ok(lp.includes(sdk), `sdk.dir must point at ANDROID_HOME (${sdk}), got: ${lp.trim()}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("scaffold fails loudly when ANDROID_HOME is unset (no silent half-project)", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newapp-t2-"));
  const app = `${work}/demo`;
  try {
    const r = scaffold(app, { ANDROID_HOME: "" });
    assert.notEqual(r.status, 0, "must exit non-zero without ANDROID_HOME");
    assert.ok((r.stderr + r.stdout).includes("ANDROID_HOME"), "error must mention ANDROID_HOME");
    assert.ok(
      !existsSync(app),
      "must fail before scaffolding, not leave a project that cannot build",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("scaffold handles a project path with spaces and derives the package from the basename", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newapp-t3-"));
  const sdk = mkdtempSync(path.join(tmpdir(), "fake-sdk-"));
  const app = path.join(work, "my expense tracker");
  try {
    const r = scaffold(app, { ANDROID_HOME: sdk });
    assert.equal(r.status, 0, `scaffold failed: ${r.stderr}`);
    assert.match(r.stdout, /Scaffolded .*my expense tracker/);
    const gradle = readFileSync(path.join(app, "app/build.gradle.kts"), "utf8");
    assert.match(gradle, /namespace = "com\.example\.myexpensetracker"/);
    assert.match(gradle, /applicationId = "com\.example\.myexpensetracker"/);
    const kt = readFileSync(
      path.join(app, "app/src/main/java/com/example/starter/MainActivity.kt"),
      "utf8",
    );
    assert.match(kt, /^package com\.example\.myexpensetracker$/m);
    assert.ok(!kt.includes("com.example.starter"), "Kotlin package references must be rewritten");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("scaffold normalizes hyphens and accepts an explicit package name", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newapp-t4-"));
  const sdk = mkdtempSync(path.join(tmpdir(), "fake-sdk-"));
  try {
    const hyphen = scaffold(path.join(work, "my-expense-tracker"), { ANDROID_HOME: sdk });
    assert.equal(hyphen.status, 0, `hyphen scaffold failed: ${hyphen.stderr}`);
    const hyphenGradle = readFileSync(
      path.join(work, "my-expense-tracker/app/build.gradle.kts"),
      "utf8",
    );
    assert.match(hyphenGradle, /applicationId = "com\.example\.myexpensetracker"/);

    const explicit = scaffold(path.join(work, "plain"), {
      ANDROID_HOME: sdk,
      // second positional arg via a small wrapper below
    });
    assert.equal(explicit.status, 0);
    const custom = spawnSync(
      "bash",
      ["scripts/new-app.sh", path.join(work, "custom"), "com.acme.expense"],
      {
        cwd: REPO,
        env: { ...process.env, ANDROID_HOME: sdk },
        encoding: "utf8",
      },
    );
    assert.equal(custom.status, 0, `explicit package scaffold failed: ${custom.stderr}`);
    const customGradle = readFileSync(path.join(work, "custom/app/build.gradle.kts"), "utf8");
    assert.match(customGradle, /namespace = "com\.acme\.expense"/);
    assert.match(customGradle, /applicationId = "com\.acme\.expense"/);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});

test("scaffold rejects a name with no usable package slug before writing anything", () => {
  const work = mkdtempSync(path.join(tmpdir(), "newapp-t5-"));
  const sdk = mkdtempSync(path.join(tmpdir(), "fake-sdk-"));
  const app = path.join(work, "!!!");
  try {
    const r = scaffold(app, { ANDROID_HOME: sdk });
    assert.notEqual(r.status, 0, "a punctuation-only name must fail");
    assert.ok(!existsSync(app), "no partial project may be written");
    assert.match(r.stderr + r.stdout, /package name/i);

    const badExplicit = spawnSync(
      "bash",
      ["scripts/new-app.sh", path.join(work, "bad"), "Com.Example"],
      {
        cwd: REPO,
        env: { ...process.env, ANDROID_HOME: sdk },
        encoding: "utf8",
      },
    );
    assert.notEqual(badExplicit.status, 0, "an invalid explicit package must fail");
    assert.ok(
      !existsSync(path.join(work, "bad")),
      "invalid explicit package must not write a project",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(sdk, { recursive: true, force: true });
  }
});
