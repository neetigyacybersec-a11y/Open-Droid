// ISSUE-143: npm run update refuses dirty, detached, diverged and
// non-fast-forwardable checkouts. Tests use temporary Git repositories and a
// recording npm stub, so no real install/build runs.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeManifest } from "../scripts/installer/manifest.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test as nodeTest, skip } from "node:test";
// The npm stub uses POSIX /bin/sh scripts; Windows CI covers these paths with
// the Linux run (same convention as test/tools.test.mjs).
const posixTest = (name, fn) => (process.platform === "win32" ? skip(name, fn) : nodeTest(name, fn));
const test = nodeTest;
const REPO = resolve(import.meta.dirname, "..");
const UPDATE = join(REPO, "scripts", "update.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Update Test",
  GIT_AUTHOR_EMAIL: "update@example.test",
  GIT_COMMITTER_NAME: "Update Test",
  GIT_COMMITTER_EMAIL: "update@example.test",
  GIT_TERMINAL_PROMPT: "0",
};
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture({ withManifest = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "update-"));
  const origin = join(base, "origin.git");
  git(base, ["init", "--bare", "origin.git"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const seed = join(base, "seed");
  git(base, ["clone", origin, seed]);
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  writeFileSync(join(seed, "tracked.txt"), "one\n");
  // ISSUE-176: a real source checkout owns the whole MCP runtime, so the
  // updater can snapshot it before advancing Git.
  mkdirSync(join(seed, "dist"), { recursive: true });
  mkdirSync(join(seed, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(seed, "dist", "index.js"), "console.log('v1');\n");
  writeFileSync(join(seed, "dist", "build-manifest.json"), JSON.stringify({ sourceFingerprint: "test" }));
  writeFileSync(join(seed, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  if (withManifest)
    writeManifest(join(seed, ".toolchain"), {
      schema: 1,
      profile: "core",
      components: { mcp: { required: true, paths: ["dist", "node_modules"] } },
    });
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["branch", "-M", "main"]);
  git(seed, ["push", "origin", "HEAD:main"]);
  const work = join(base, "work");
  git(base, ["clone", origin, work]);
  git(work, ["config", "user.name", "Update Test"]);
  git(work, ["config", "user.email", "update@example.test"]);
  return { base, origin, seed, work };
}
function advance(seed, text = "two\n") {
  writeFileSync(join(seed, "tracked.txt"), text);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "upstream change"]);
  git(seed, ["push", "origin", "HEAD:main"]);
}
function npmStub(base, { failAt } = {}) {
  const bin = join(base, "bin");
  const record = join(base, "npm-calls.txt");
  mkdirSync(bin, { recursive: true });
  writeFileSync(record, "");
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${record}"
if [ "$*" = "${failAt}" ]; then
  echo "npm stub failed: $*" >&2
  exit 7
fi
exit 0
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  return { bin, record, calls: () => readFileSync(record, "utf8").trim().split("\n").filter(Boolean) };
}
function update(work, bin) {
  return spawnSync(process.execPath, [UPDATE, "--root", work, "--no-register"], {
    cwd: work,
    encoding: "utf8",
    env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
}
posixTest("dirty, staged and untracked trees abort without touching the checkout", () => {
  for (const kind of ["unstaged", "staged", "untracked"]) {
    const f = fixture();
    try {
      advance(f.seed);
      const before = git(f.work, ["rev-parse", "HEAD"]);
      if (kind === "unstaged") writeFileSync(join(f.work, "tracked.txt"), "local\n");
      if (kind === "staged") {
        writeFileSync(join(f.work, "tracked.txt"), "local\n");
        git(f.work, ["add", "tracked.txt"]);
      }
      if (kind === "untracked") writeFileSync(join(f.work, "scratch.txt"), "local\n");
      const stub = npmStub(f.base);
      const result = update(f.work, stub.bin);
      assert.equal(result.status, 1, kind);
      assert.match(result.stderr, /working tree is dirty/i, kind);
      assert.equal(git(f.work, ["rev-parse", "HEAD"]), before, kind);
      assert.deepEqual(stub.calls(), [], kind);
    } finally {
      rmSync(f.base, { recursive: true, force: true });
    }
  }
});
posixTest("a clean checkout fast-forwards and runs install, build and verify in order", () => {
  const f = fixture();
  try {
    advance(f.seed);
    const target = git(f.seed, ["rev-parse", "HEAD"]);
    const stub = npmStub(f.base);
    const result = update(f.work, stub.bin);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.work, ["rev-parse", "HEAD"]), target);
    assert.deepEqual(stub.calls(), ["ci", "run build", "run verify"]);
    assert.match(result.stdout, /update complete/);
    assert.match(result.stdout, /Restart the MCP client/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
posixTest("a diverged branch aborts before install or build", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "local.txt"), "local\n");
    git(f.work, ["add", "local.txt"]);
    git(f.work, ["commit", "-m", "local work"]);
    advance(f.seed);
    const before = git(f.work, ["rev-parse", "HEAD"]);
    const stub = npmStub(f.base);
    const result = update(f.work, stub.bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /diverged/i);
    assert.equal(git(f.work, ["rev-parse", "HEAD"]), before);
    assert.deepEqual(stub.calls(), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
posixTest("detached HEAD and fetch failure abort safely", () => {
  const f = fixture();
  try {
    git(f.work, ["checkout", "--detach", "HEAD"]);
    const stub = npmStub(f.base);
    let result = update(f.work, stub.bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /detached HEAD/i);
    git(f.work, ["checkout", "main"]);
    git(f.work, ["remote", "set-url", "origin", join(f.base, "missing.git")]);
    result = update(f.work, stub.bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fetch failed/i);
    assert.deepEqual(stub.calls(), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
posixTest("an absent install manifest fails closed before the fast-forward", () => {
  const f = fixture({ withManifest: false });
  try {
    advance(f.seed);
    const before = git(f.work, ["rev-parse", "HEAD"]);
    const stub = npmStub(f.base);
    const result = update(f.work, stub.bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no last-known-good runtime snapshot/);
    assert.equal(git(f.work, ["rev-parse", "HEAD"]), before, "checkout must not advance");
    assert.deepEqual(stub.calls(), [], "no install/build ran without a snapshot");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

posixTest("a broken build restores the whole MCP runtime before reporting", () => {
  const f = fixture();
  try {
    advance(f.seed);
    const bin = join(f.base, "bin-mutate");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
if [ "$*" = "ci" ]; then
  echo "broken" > "${f.work}/dist/index.js"
  rm -rf "${f.work}/node_modules/dep"
fi
if [ "$*" = "run build" ]; then exit 7; fi
exit 0
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    const result = update(f.work, bin);
    assert.equal(result.status, 1);
    assert.equal(
      readFileSync(join(f.work, "dist", "index.js"), "utf8"),
      "console.log('v1');\n",
      "compiled entrypoint must be restored from the generation",
    );
    assert.equal(existsSync(join(f.work, "node_modules", "dep", "index.js")), true, "dependencies must be restored too");
    assert.match(result.stderr, /restored verified|manual recovery required/, "rollback outcome must be explicit");
    assert.doesNotMatch(result.stderr, /restored last-known-good generation/, "no unverified success claim");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

posixTest("a failing build stage stops before verify and reports the stage", () => {
  const f = fixture();
  try {
    advance(f.seed);
    const stub = npmStub(f.base, { failAt: "run build" });
    const result = update(f.work, stub.bin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /build failed/);
    assert.deepEqual(stub.calls(), ["ci", "run build"]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
posixTest("an up-to-date checkout does not run install/build", () => {
  const f = fixture();
  try {
    const stub = npmStub(f.base);
    const result = update(f.work, stub.bin);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /already up to date/);
    assert.deepEqual(stub.calls(), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
test("the update script never resets, force-pushes or rebases", () => {
  const source = readFileSync(UPDATE, "utf8");
  assert.doesNotMatch(source, /reset\s+--hard/);
  assert.doesNotMatch(source, /push\s+--force|push\s+-f\b/);
  assert.doesNotMatch(source, /git["'\s,\]]+rebase/);
});
