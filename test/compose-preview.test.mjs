// FR-A1 / ISSUE-15: compose_preview_render used to shell out to `render` and
// return raw text, so an agent still had to find the PNGs on disk. The tool
// must run the installed compose-preview CLI headlessly, parse its JSON
// manifest, report id/module/path/hash/timing, and inline the images.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const work = mkdtempSync(join(tmpdir(), "compose-preview-"));
const bin = join(work, "bin");
const emptyBin = join(work, "empty-bin");
const project = join(work, "project");
const png = join(work, "GreetingPreview-a6fd142b.png");
const payload = join(work, "payload.json");
const record = join(work, "args.txt");

mkdirSync(bin, { recursive: true });
mkdirSync(emptyBin, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(png, Buffer.from("89504e470d0a1a0a", "hex"));

const SHA = "1bdf48647f6403460c6e87b3e6850acc4c65ab169b66fd03d324e9bdb9779968";

function payloadFor(previews) {
  return {
    schema: "compose-preview-show/v2",
    previews,
    counts: { total: previews.length, changed: previews.length },
  };
}

function previewFor(id, pngPath = png, module = "app") {
  return {
    id,
    module,
    functionName: id.split(".").pop(),
    sourceFile: "src/main/java/com/example/starter/MainActivity.kt",
    pngPath,
    sha256: SHA,
    captures: [{ pngPath, sha256: SHA, changed: true, optional: false }],
  };
}

writeFileSync(
  payload,
  JSON.stringify(payloadFor([previewFor("com.example.starter.MainActivityKt.GreetingPreview")])),
);

const stub = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$STUB_RECORD"
mode="$STUB_MODE"
if [ "$mode" = "fail" ]; then
  echo "gradle build failed: boom" >&2
  exit 7
fi
if [ "$mode" = "invalid-json" ]; then
  echo "this is not json"
  exit 0
fi
if [ "$mode" = "empty" ]; then
  printf '{"schema":"compose-preview-show/v2","previews":[],"counts":{"total":0}}\n'
  exit 0
fi
cat "$STUB_PAYLOAD"
`;
writeFileSync(join(bin, "compose-preview"), stub);
chmodSync(join(bin, "compose-preview"), 0o755);

const basePath = process.env.PATH ?? "";
process.env.PATH = `${bin}:${basePath}`;
process.env.STUB_RECORD = record;
process.env.STUB_PAYLOAD = payload;

const { test, skip } = await import("node:test");
const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

const { handleComposePreviewRender } = await import("../dist/tools.js");

function reset(extra = {}) {
  process.env.PATH = `${bin}:${basePath}`;
  process.env.STUB_MODE = extra.mode ?? "ok";
  process.env.STUB_PAYLOAD = extra.payload ?? payload;
  writeFileSync(record, "");
}

const calls = () =>
  readFileSync(record, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const images = (result) => result.content.filter((block) => block.type === "image");

test.after(() => {
  rmSync(work, { recursive: true, force: true });
});

posixTest("renders every preview and returns paths, hashes and inline PNGs (FR-A1)", async () => {
  reset();
  try {
    const result = await handleComposePreviewRender({
      projectPath: relative(process.cwd(), project),
    });
    assert.equal(result.isError, false);

    // A headless double-click: `show` renders and tells us where the PNGs are.
    assert.deepEqual(calls(), [`show --project ${project} --json`]);

    const text = result.content[0].text;
    assert.match(text, /rendered 1 preview/i);
    assert.match(text, /com\.example\.starter\.MainActivityKt\.GreetingPreview/);
    assert.match(text, /module: app/);
    assert.match(text, new RegExp(`sha256: ${SHA.slice(0, 12)}`));
    assert.match(text, new RegExp(png.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /in \d+\.\d+s/);

    const pngs = images(result);
    assert.equal(pngs.length, 1);
    assert.equal(pngs[0].mimeType, "image/png");
    assert.equal(pngs[0].data, Buffer.from("89504e470d0a1a0a", "hex").toString("base64"));
  } finally {
    reset();
  }
});

posixTest("selects a module and an exact preview id", async () => {
  reset();
  try {
    const result = await handleComposePreviewRender({
      projectPath: project,
      module: "app",
      previewFqn: "com.example.starter.MainActivityKt.GreetingPreview",
    });
    assert.equal(result.isError, false);
    assert.deepEqual(calls(), [
      `show --project ${project} --json --module app --id com.example.starter.MainActivityKt.GreetingPreview`,
    ]);
  } finally {
    reset();
  }
});

posixTest("inlineImages=false reports the files without embedding them", async () => {
  reset();
  try {
    const result = await handleComposePreviewRender({
      projectPath: project,
      inlineImages: false,
    });
    assert.equal(result.isError, false);
    assert.equal(images(result).length, 0);
    assert.match(result.content[0].text, /GreetingPreview/);
    assert.match(result.content[0].text, /inline images disabled/);
  } finally {
    reset();
  }
});

posixTest("caps inline images so a huge module cannot flood the context", async () => {
  const previews = [];
  for (let i = 0; i < 8; i += 1) {
    const file = join(work, `preview-${i}.png`);
    writeFileSync(file, Buffer.from("89504e470d0a1a0a", "hex"));
    previews.push(previewFor(`com.example.starter.Preview${i}`, file));
  }
  const capPayload = join(work, "cap-payload.json");
  writeFileSync(capPayload, JSON.stringify(payloadFor(previews)));
  reset({ payload: capPayload });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, false);
    assert.equal(images(result).length, 6);
    assert.match(result.content[0].text, /inline images capped at 6/i);
    assert.match(result.content[0].text, /Preview7/);
  } finally {
    reset();
  }
});

posixTest("an oversized PNG is skipped with a size message, not a false cap warning", async () => {
  const huge = join(work, "huge.png");
  writeFileSync(huge, Buffer.alloc(8 * 1024 * 1024 + 1));
  const hugePayload = join(work, "huge-payload.json");
  writeFileSync(
    hugePayload,
    JSON.stringify(payloadFor([previewFor("com.example.starter.Huge", huge)])),
  );
  reset({ payload: hugePayload });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, false);
    assert.equal(images(result).length, 0);
    assert.match(result.content[0].text, /inline: skipped/);
    assert.doesNotMatch(result.content[0].text, /capped at/);
  } finally {
    reset();
  }
});

posixTest("a preview whose PNG is absent is reported, not silently inlined", async () => {
  const missingPayload = join(work, "missing-payload.json");
  writeFileSync(
    missingPayload,
    JSON.stringify(payloadFor([previewFor("com.example.starter.Gone", join(work, "gone.png"))])),
  );
  reset({ payload: missingPayload });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no preview PNG/i);
    assert.match(result.content[0].text, /gone\.png/);
    assert.equal(images(result).length, 0);
  } finally {
    reset();
  }
});

posixTest("CLI failure surfaces the exit code and stderr", async () => {
  reset({ mode: "fail" });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /compose-preview show failed \(exit 7\)/);
    assert.match(result.content[0].text, /gradle build failed: boom/);
  } finally {
    reset();
  }
});

posixTest("invalid JSON is a clear error, not a stack trace", async () => {
  reset({ mode: "invalid-json" });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid JSON/i);
    assert.match(result.content[0].text, /this is not json/);
  } finally {
    reset();
  }
});

posixTest("an empty preview list explains how to widen the selection", async () => {
  reset({ mode: "empty" });
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no previews/i);
    assert.match(result.content[0].text, /--module|previewFqn/);
  } finally {
    reset();
  }
});

posixTest("missing compose-preview CLI points at make setup", async () => {
  process.env.PATH = emptyBin;
  process.env.STUB_MODE = "ok";
  try {
    const result = await handleComposePreviewRender({ projectPath: project });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /compose-preview/);
    assert.match(result.content[0].text, /make setup/);
  } finally {
    process.env.PATH = `${bin}:${basePath}`;
  }
});
