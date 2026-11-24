// ISSUE-141: invoke representative MCP handlers inside the image using only
// the tools carried by the image. Device-dependent handlers are expected to
// report "no device", never "tool missing".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "docker-mcp-smoke-"));
process.env.ANDROID_MCP_WORKSPACE = work;
const {
  handleEnvCheck,
  handleGradle,
  handleComposePreviewRender,
  handleSkillsSearch,
  handleApkInfo,
  handleApkDecompile,
  handleFridaPs,
} = await import("../dist/tools.js");
const { handleNetCapture } = await import("../dist/netCapture.js");

const text = (result) => result.content.map((entry) => entry.text ?? "").join("\n");
const step = (name, fn) => {
  console.log(`smoke: ${name}`);
  return fn();
};

await step("android_env_check", async () => {
  const report = text(await handleEnvCheck());
  for (const tool of [
    "gradle",
    "adb",
    "maestro",
    "compose-preview",
    "android CLI",
    "aapt2",
    "jadx",
    "apktool",
    "frida",
    "frida-ps",
    "mitmdump",
  ]) {
    assert.doesNotMatch(report, new RegExp(`^${tool}: MISSING`, "m"), `${tool} reported MISSING`);
  }
});

await step("gradle_task", async () => {
  writeFileSync(
    join(work, "build.gradle"),
    'tasks.register("smokeHello") { doLast { println "smoke-ok" } }\n',
  );
  const result = await handleGradle({ projectPath: work, task: "smokeHello" });
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /smoke-ok/);
});

await step("compose_preview_render reaches the CLI", async () => {
  const result = await handleComposePreviewRender({
    projectPath: join(work, "no-project"),
    timeoutSec: 30,
  });
  assert.doesNotMatch(text(result), /compose-preview CLI not found/);
});

await step("android_skills_search reaches the CLI", async () => {
  const result = await handleSkillsSearch({ query: "compose" });
  assert.doesNotMatch(text(result), /Android CLI not found/);
});

const apk = join(work, "smoke.apk");
const manifest = join(work, "AndroidManifest.xml");
writeFileSync(
  manifest,
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android" ' +
    'package="com.example.smoke" android:versionCode="1" android:versionName="1.0">' +
    '<application android:label="Smoke"/></manifest>\n',
);
execFileSync(
  "aapt2",
  [
    "link",
    "-o",
    apk,
    "--manifest",
    manifest,
    "-I",
    `${process.env.ANDROID_HOME}/platforms/android-35/android.jar`,
  ],
  { stdio: "pipe" },
);

await step("apk_info via aapt2", async () => {
  const result = await handleApkInfo({ apkPath: apk });
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /package:/);
});

for (const tool of ["jadx", "apktool"]) {
  await step(`apk_decompile via ${tool}`, async () => {
    const result = await handleApkDecompile({
      apkPath: apk,
      outputDir: join(work, `out-${tool}`),
      tool,
    });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), new RegExp(`tool=${tool}[\\s\\S]*exit=0`));
  });
}

async function deviceBoundary(name, invoke) {
  await step(name, async () => {
    let output;
    try {
      output = text(await invoke());
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    assert.match(output, /adb|device/i, output);
    assert.doesNotMatch(output, /frida CLI not found|frida-server for ABI.*not found|mitmdump.*not found/);
  });
}

await deviceBoundary("frida_ps reports device-unavailable", () => handleFridaPs({}));
await deviceBoundary("net_capture reports device-unavailable", () =>
  handleNetCapture({ action: "start", durationSec: 1 }),
);

console.log("MCP handler smoke OK");
