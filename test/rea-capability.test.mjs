// ISSUE-142: the REA MCP is optional. android_env_check must report it as a
// capability (with exact setup) instead of implying the server bundles it.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const work = mkdtempSync(join(tmpdir(), "rea-capability-"));
const { handleEnvCheck } = await import("../dist/tools.js");
function withJar(value, fn) {
  const previous = process.env.REA_JADX_MCP_JAR;
  if (value === undefined) delete process.env.REA_JADX_MCP_JAR;
  else process.env.REA_JADX_MCP_JAR = value;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.REA_JADX_MCP_JAR;
    else process.env.REA_JADX_MCP_JAR = previous;
  });
}
async function line() {
  const result = await handleEnvCheck();
  return result.content[0].text
    .split("\n")
    .find((entry) => entry.startsWith("rea provider:"));
}
test.after(() => rmSync(work, { recursive: true, force: true }));
test("unconfigured REA is reported as optional with the exact setup command", async () => {
  await withJar(undefined, async () => {
    const text = await line();
    assert.match(text, /unavailable/);
    assert.match(text, /npx -y rea-agents@6\.3\.0 setup --client opencode --yes/);
    assert.match(text, /inspect_android_package, search_android_classes/);
  });
});
test("an existing JAR reports configured; a missing path reports unavailable", async () => {
  const jar = join(work, "jadx-headless-mcp.jar");
  writeFileSync(jar, "jar");
  await withJar(jar, async () => {
    assert.match(await line(), /configured/);
  });
  await withJar(join(work, "missing.jar"), async () => {
    assert.match(await line(), /is missing/);
  });
});
