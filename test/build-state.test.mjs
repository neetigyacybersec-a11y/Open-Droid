// ISSUE-144: launch scripts must distinguish a missing build from one built
// from older TypeScript sources. Production images may omit src/, where the
// manifest alone is authoritative.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
const REPO = resolve(import.meta.dirname, "..");
const STATE = join(REPO, "scripts", "build-state.mjs");
const MANIFEST = join(REPO, "scripts", "build-manifest.mjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "build-state-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }));
  writeFileSync(join(root, "src", "index.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "dist", "index.js"), "export const a = 1;\n");
  return root;
}
function run(script, root, extra = []) {
  return spawnSync(process.execPath, [script, "--root", root, ...extra], { encoding: "utf8" });
}
function state(root) {
  const result = run(STATE, root);
  return { code: result.status, line: result.stdout.trim() };
}
test("missing dist is reported with rebuild guidance", () => {
  const root = fixture();
  try {
    rmSync(join(root, "dist"), { recursive: true, force: true });
    const result = state(root);
    assert.equal(result.code, 0);
    assert.match(result.line, /build missing/);
    assert.match(result.line, /npm run build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a dist without a manifest is stale, and a build makes it current", () => {
  const root = fixture();
  try {
    assert.match(state(root).line, /build stale/);
    const built = run(MANIFEST, root);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(existsSync(join(root, "dist", "build-manifest.json")), true);
    const manifest = JSON.parse(readFileSync(join(root, "dist", "build-manifest.json"), "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.match(state(root).line, /build current/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a source change that leaves dist untouched is detected as stale", () => {
  const root = fixture();
  try {
    assert.equal(run(MANIFEST, root).status, 0);
    const before = readFileSync(join(root, "dist", "index.js"), "utf8");
    writeFileSync(join(root, "src", "index.ts"), "export const a = 2;\n");
    assert.equal(readFileSync(join(root, "dist", "index.js"), "utf8"), before);
    assert.match(state(root).line, /build stale/);
    assert.equal(run(STATE, root, ["--require-current"]).status, 1);
    assert.equal(run(MANIFEST, root).status, 0);
    assert.match(state(root).line, /build current/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("production images without src/ trust the manifest", () => {
  const root = fixture();
  try {
    assert.equal(run(MANIFEST, root).status, 0);
    rmSync(join(root, "src"), { recursive: true, force: true });
    assert.match(state(root).line, /build current/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("launch scripts refuse stale builds before exec", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.match(pkg.scripts.start, /build-state\.mjs --require-current/);
  const launcher = readFileSync(join(REPO, "scripts", "run-mcp.sh"), "utf8");
  assert.match(launcher, /build-state\.mjs" --require-current/);
  assert.match(launcher, /exit 1/);
});
