// Issue 16: persistent capture archive + managed golden baselines.
import { afterEach, skip, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const mod = () => import("../dist/captures.js");
const digest = (value) => createHash("sha256").update(value).digest("hex");

const workspaces = [];
const savedEnv = {};

async function workspace(prefix = "captures-test-") {
  const work = await mkdtemp(join(tmpdir(), prefix));
  workspaces.push(work);
  for (const key of ["ANDROID_MCP_CAPTURES_DIR", "ANDROID_MCP_CAPTURES_KEEP"]) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.ANDROID_MCP_CAPTURES_DIR = work;
  delete process.env.ANDROID_MCP_CAPTURES_KEEP;
  return work;
}

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  for (const work of workspaces.splice(0)) await rm(work, { recursive: true, force: true });
});

test("capture config is env-overridable with safe defaults", async () => {
  const { capturesDir, baselinesDir, capturesKeep } = await mod();
  const work = await workspace();

  assert.equal(capturesDir(), work);
  assert.equal(baselinesDir(), join(work, "baselines"));
  assert.equal(capturesKeep(), 200, "missing retention env has a bounded default");

  process.env.ANDROID_MCP_CAPTURES_KEEP = "7";
  assert.equal(capturesKeep(), 7);
  process.env.ANDROID_MCP_CAPTURES_KEEP = "not-a-number";
  assert.equal(capturesKeep(), 200, "invalid retention env falls back to the default");
  process.env.ANDROID_MCP_CAPTURES_KEEP = "0";
  assert.equal(capturesKeep(), 200, "retention must be positive");

  delete process.env.ANDROID_MCP_CAPTURES_DIR;
  assert.match(
    capturesDir(),
    /\.android-mcp[\\/]captures$/,
    "default persists under the user home",
  );
});

test("capture names are timestamped and self-describing", async () => {
  const { nextCapturePath } = await mod();
  await workspace();

  const screenshot = nextCapturePath({
    kind: "screenshot",
    deviceId: "emulator-5554",
    packageName: "com.example.app",
    epochMs: 1700000000123,
  });
  assert.match(screenshot, /screenshot-emulator-5554-com\.example\.app-1700000000123\.png$/);

  const recording = nextCapturePath({
    kind: "screenrecord",
    deviceId: "a/b c",
    packageName: "",
    epochMs: 1700000000456,
  });
  assert.match(recording, /screenrecord-a_b_c-unknown-1700000000456\.mp4$/);
  assert.equal(
    basename(recording).includes("/"),
    false,
    "segments must not introduce path separators",
  );
});

test("prune keeps the newest captures and never touches baselines", async () => {
  const { pruneCaptures } = await mod();
  const work = await workspace();
  await mkdir(join(work, "baselines"), { recursive: true });

  for (const epoch of [100, 200, 300]) {
    await writeFile(join(work, `screenshot-device-unknown-${epoch}.png`), `capture-${epoch}`);
  }
  await writeFile(join(work, "baselines", "keeper.png"), "baseline");

  assert.equal(await pruneCaptures(2), 1, "one old capture is removed");
  const remaining = (await readdir(work)).filter((f) => f.endsWith(".png"));
  assert.deepEqual(remaining.sort(), [
    "screenshot-device-unknown-200.png",
    "screenshot-device-unknown-300.png",
  ]);
  assert.equal(await readFile(join(work, "baselines", "keeper.png"), "utf8"), "baseline");
});

test("saveBaseline stores the image and metadata with a sha256 digest", async () => {
  const { resolveBaseline, saveBaseline } = await mod();
  const work = await workspace();
  const source = join(work, "source.png");
  await writeFile(source, "PNGDATA");

  const saved = await saveBaseline({
    name: "post-reveal",
    sourcePath: source,
    deviceId: "emulator-5554",
    packageName: "com.example.app",
  });
  assert.equal(saved.name, "post-reveal");
  assert.match(saved.path, /baselines[\\/]post-reveal\.png$/);
  assert.equal(saved.sha256, digest("PNGDATA"));
  assert.equal(await readFile(saved.path, "utf8"), "PNGDATA");

  const metadata = JSON.parse(await readFile(saved.metadataPath, "utf8"));
  assert.equal(metadata.name, "post-reveal");
  assert.equal(metadata.deviceId, "emulator-5554");
  assert.equal(metadata.packageName, "com.example.app");
  assert.equal(metadata.sha256, saved.sha256);

  const resolved = await resolveBaseline("post-reveal");
  assert.equal(resolved.path, saved.path);
  assert.equal(resolved.sha256, saved.sha256);

  await assert.rejects(
    () => saveBaseline({ name: "post-reveal", sourcePath: source }),
    /exists|overwrite/i,
    "an existing baseline is not silently overwritten",
  );

  const replacement = join(work, "replacement.png");
  await writeFile(replacement, "NEWFRAME");
  const replaced = await saveBaseline({
    name: "post-reveal",
    sourcePath: replacement,
    overwrite: true,
  });
  assert.equal(replaced.sha256, digest("NEWFRAME"));
  assert.equal(await readFile(replaced.path, "utf8"), "NEWFRAME");
});

test("baseline names are validated and list returns sorted metadata", async () => {
  const { isValidBaselineName, listBaselines, resolveBaseline, saveBaseline } = await mod();
  const work = await workspace();
  const source = join(work, "source.png");
  await writeFile(source, "FRAME");

  assert.equal(isValidBaselineName("post-reveal"), true);
  assert.equal(isValidBaselineName("state_42"), true);
  assert.equal(isValidBaselineName("../escape"), false);
  assert.equal(isValidBaselineName("a/b"), false);
  assert.equal(isValidBaselineName(""), false);
  assert.equal(isValidBaselineName("-leading"), false);

  await assert.rejects(
    () => saveBaseline({ name: "../escape", sourcePath: source }),
    /invalid/i,
    "path traversal in a baseline name is rejected",
  );
  assert.equal(await resolveBaseline("missing"), null);

  await saveBaseline({ name: "zeta", sourcePath: source });
  await saveBaseline({ name: "alpha", sourcePath: source });
  const listed = await listBaselines();
  assert.deepEqual(
    listed.map((entry) => entry.name),
    ["alpha", "zeta"],
  );
  assert.equal(listed[0].sha256, digest("FRAME"));
});

// --- handler behavior -------------------------------------------------------
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import * as ToolHandlers from "../dist/tools.js";

const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

async function withAdbStub(run) {
  const work = await mkdtemp(join(tmpdir(), "captures-adb-"));
  workspaces.push(work);
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = String.raw`#!/bin/sh
if [ "$1" = "-s" ]; then shift 2; fi
if [ "$1" = "shell" ] && [ "$2" = "screencap" ]; then printf '%s\n' "$4" >> "$RECORD"; exit 0; fi
if [ "$1" = "shell" ] && [ "$2" = "screenrecord" ]; then exit 0; fi
if [ "$1" = "pull" ]; then printf 'PNGDATA' > "$3"; exit 0; fi
if [ "$1" = "shell" ] && [ "$2" = "rm" ]; then exit 0; fi
exit 0
`;
  writeFileSync(join(bin, "adb"), stub, { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousRecord = process.env.RECORD;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.RECORD = join(work, "adb.log");
  try {
    return await run(work);
  } finally {
    process.env.PATH = previousPath;
    if (previousRecord === undefined) delete process.env.RECORD;
    else process.env.RECORD = previousRecord;
  }
}

function resultText(result) {
  return result.content.map((part) => part.text ?? "").join("\n");
}

posixTest(
  "adb_screenshot archives by default and keeps an explicit transient opt-out",
  async () => {
    const archive = await workspace();
    await withAdbStub(async () => {
      const archived = await ToolHandlers.handleAdbScreenshot({
        deviceId: "emulator-5554",
        packageName: "com.example.app",
      });
      assert.equal(archived.isError, false);
      assert.ok(archived.content.some((part) => part.type === "image"));
      const text = resultText(archived);
      assert.match(text, /Saved screenshot to/);
      const saved = /Saved screenshot to (.+)/.exec(text)?.[1];
      assert.ok(saved, "archived path must be reported");
      assert.match(saved, /screenshot-emulator-5554-com\.example\.app-\d+\.png$/);
      assert.equal(await readFile(saved, "utf8"), "PNGDATA");

      const transient = await ToolHandlers.handleAdbScreenshot({ transient: true });
      assert.equal(transient.isError, false);
      assert.doesNotMatch(resultText(transient), /Saved screenshot to/);
      assert.match(resultText(transient), /transient|inline/i);
    });
    const files = await readdir(archive);
    assert.equal(
      files.filter((file) => file.endsWith(".png")).length,
      1,
      "transient must not archive",
    );
  },
);

posixTest("adb_screenrecord archives by default with a self-describing name", async () => {
  const archive = await workspace();
  await withAdbStub(async () => {
    const result = await ToolHandlers.handleAdbScreenrecord({
      deviceId: "emulator-5554",
      packageName: "com.example.app",
      durationSec: 1,
    });
    assert.equal(result.isError, false, resultText(result));
    assert.match(resultText(result), /screenrecord-emulator-5554-com\.example\.app-\d+\.mp4/);
  });
  const files = await readdir(archive);
  assert.equal(files.filter((file) => file.endsWith(".mp4")).length, 1);
});

posixTest("capture retention drops the oldest archived captures only", async () => {
  const archive = await workspace();
  process.env.ANDROID_MCP_CAPTURES_KEEP = "1";
  await withAdbStub(async () => {
    const first = await ToolHandlers.handleAdbScreenshot({ deviceId: "one" });
    const second = await ToolHandlers.handleAdbScreenshot({ deviceId: "two" });
    assert.equal(first.isError, false);
    assert.equal(second.isError, false);
  });
  const files = (await readdir(archive)).filter((file) => file.endsWith(".png"));
  assert.equal(files.length, 1, "retention cap is enforced after each archived capture");
});

test("baseline schemas validate names and source arguments", () => {
  const { ToolSchemas } = ToolHandlers;
  assert.doesNotThrow(() =>
    ToolSchemas.screenshotBaselineSave.parse({ name: "post-reveal", sourcePath: "/tmp/frame.png" }),
  );
  assert.throws(() =>
    ToolSchemas.screenshotBaselineSave.parse({ name: "../escape", sourcePath: "/tmp/frame.png" }),
  );
  assert.doesNotThrow(() => ToolSchemas.screenshotBaselineSave.parse({ name: "post-reveal" }));
  assert.throws(() => ToolSchemas.screenshotBaselineSave.parse({ sourcePath: "/tmp/frame.png" }));
  assert.doesNotThrow(() => ToolSchemas.screenshotBaselineList.parse({}));
});

test("screenshot_baseline_save and list manage a named baseline from a source file", async () => {
  await workspace();
  const source = join(await mkdtemp(join(tmpdir(), "baseline-src-")), "frame.png");
  await writeFile(source, "FRAME");
  workspaces.push(join(source, ".."));

  const saved = await ToolHandlers.handleScreenshotBaselineSave({
    name: "post-reveal",
    sourcePath: source,
    deviceId: "emulator-5554",
    packageName: "com.example.app",
  });
  assert.equal(saved.isError, false, resultText(saved));
  assert.match(resultText(saved), /post-reveal/);
  assert.match(resultText(saved), /sha256=[0-9a-f]{64}/);

  const listed = await ToolHandlers.handleScreenshotBaselineList({});
  assert.equal(listed.isError, false, resultText(listed));
  assert.match(resultText(listed), /post-reveal/);
  assert.match(resultText(listed), /com\.example\.app/);
});

posixTest(
  "screenshot_baseline_save can adopt a fresh capture when no source is given",
  async () => {
    await workspace();
    await withAdbStub(async () => {
      const saved = await ToolHandlers.handleScreenshotBaselineSave({
        name: "fresh-frame",
        deviceId: "emulator-5554",
      });
      assert.equal(saved.isError, false, resultText(saved));
      assert.match(resultText(saved), /sha256=[0-9a-f]{64}/);
    });
    const listed = await ToolHandlers.handleScreenshotBaselineList({});
    assert.match(resultText(listed), /fresh-frame/);
  },
);
