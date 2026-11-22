// ISSUE-20: `make register` must install complete skill directories, not just
// SKILL.md. Reference-heavy skills (android-compose-ui-ux/references/motion)
// currently appear installed while their linked files are missing.
import { test, skip } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const REGISTER = join(REPO, "scripts", "register.sh");
const posixTest = process.platform === "win32" ? (name, fn) => skip(name, fn) : test;

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function fixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "register-test-"));
  const home = join(root, "home");
  const src = join(root, "skills-src");
  const dst = join(root, "skills-dst");
  mkdirSync(home, { recursive: true });
  writeTree(src, files);
  return { root, home, src, dst };
}

const PATH_SEP = process.platform === "win32" ? ";" : ":";

function register(context, extraEnv = {}, pathPrefix = "") {
  return spawnSync("bash", [REGISTER], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: context.home,
      ANDROID_MCP_SKILLS_SRC: context.src,
      ANDROID_MCP_SKILLS_DST: context.dst,
      ANDROID_MCP_SKIP_MCP_REGISTRATION: "1",
      PATH: pathPrefix ? `${pathPrefix}${PATH_SEP}${process.env.PATH}` : process.env.PATH,
      ...extraEnv,
    },
  });
}

test("a fresh registration installs nested references, templates and examples", (t) => {
  const context = fixture({
    "hub/SKILL.md": "---\nname: hub\n---\nSee references/motion/timing.md.\n",
    "hub/references/motion/timing.md": "# Timing\nspring tokens\n",
    "hub/references/motion/nested/deep.md": "deep reference\n",
    "hub/templates/MotionTokens.kt": "val motion = 1\n",
    "other/SKILL.md": "---\nname: other\n---\n",
    "other/examples/demo.txt": "example asset\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));

  const result = register(context);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Installed\/refreshed 2 skills/);
  for (const relative of [
    "hub/SKILL.md",
    "hub/references/motion/timing.md",
    "hub/references/motion/nested/deep.md",
    "hub/templates/MotionTokens.kt",
    "other/SKILL.md",
    "other/examples/demo.txt",
  ]) {
    assert.ok(existsSync(join(context.dst, relative)), `missing installed file ${relative}`);
  }
  assert.equal(
    readFileSync(join(context.dst, "hub/references/motion/timing.md"), "utf8"),
    "# Timing\nspring tokens\n",
  );
  assert.deepEqual(
    readFileSync(join(context.dst, ".android-mcp-manifest"), "utf8").trim().split("\n").sort(),
    ["hub", "other"],
  );
});

test("a real registration installs the full android-compose-ui-ux motion tree", (t) => {
  const home = mkdtempSync(join(tmpdir(), "register-real-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync("bash", [REGISTER], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      ANDROID_MCP_SKIP_MCP_REGISTRATION: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const installed = join(home, ".config/opencode/skills/android-compose-ui-ux");
  const source = join(REPO, "skills/android-compose-ui-ux");
  for (const relative of [
    "SKILL.md",
    "references/motion/timing-and-easing.md",
    "references/motion/compose-motion.md",
    "references/motion/view-system-motion.md",
    "references/motion/micro-interactions-catalog.md",
    "references/motion/performance-and-accessibility.md",
    "references/motion/review-checklist.md",
    "references/motion/MotionTokens.kt",
    "references/motion/evals.json",
  ]) {
    assert.ok(existsSync(join(installed, relative)), `missing ${relative}`);
    assert.equal(
      readFileSync(join(installed, relative), "utf8"),
      readFileSync(join(source, relative), "utf8"),
      `${relative} must match the repository copy`,
    );
  }
});

test("re-running refreshes changed resources and prunes stale files in owned skills", (t) => {
  const context = fixture({
    "hub/SKILL.md": "v1\n",
    "hub/references/motion/timing.md": "old timing\n",
    "hub/references/motion/removed.md": "stale\n",
    "hub/templates/removed.txt": "stale template\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));

  const first = register(context);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.ok(existsSync(join(context.dst, "hub/references/motion/removed.md")));

  writeFileSync(join(context.src, "hub/references/motion/timing.md"), "new timing\n");
  writeFileSync(join(context.src, "hub/references/motion/added.md"), "new file\n");
  rmSync(join(context.src, "hub/references/motion/removed.md"));
  rmSync(join(context.src, "hub/templates"), { recursive: true, force: true });

  const second = register(context);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(
    readFileSync(join(context.dst, "hub/references/motion/timing.md"), "utf8"),
    "new timing\n",
  );
  assert.ok(existsSync(join(context.dst, "hub/references/motion/added.md")));
  assert.ok(
    !existsSync(join(context.dst, "hub/references/motion/removed.md")),
    "stale reference must be pruned",
  );
  assert.ok(
    !existsSync(join(context.dst, "hub/templates/removed.txt")),
    "stale template must be pruned",
  );
  assert.ok(
    !existsSync(join(context.dst, "hub/templates")),
    "empty stale directory must be pruned",
  );
});

test("unrelated global skills and files are never modified or pruned", (t) => {
  const context = fixture({
    "hub/SKILL.md": "owned\n",
    "hub/references/note.md": "owned reference\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  writeTree(context.dst, {
    "user-skill/SKILL.md": "user skill\n",
    "user-skill/notes.md": "user notes\n",
    "loose-file.txt": "user file\n",
  });

  const first = register(context);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(readFileSync(join(context.dst, "user-skill/SKILL.md"), "utf8"), "user skill\n");
  assert.equal(readFileSync(join(context.dst, "loose-file.txt"), "utf8"), "user file\n");
  assert.ok(existsSync(join(context.dst, "hub/references/note.md")));

  rmSync(join(context.src, "hub"), { recursive: true, force: true });
  const second = register(context);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.ok(!existsSync(join(context.dst, "hub")), "removed owned skill must be pruned");
  assert.equal(readFileSync(join(context.dst, "user-skill/SKILL.md"), "utf8"), "user skill\n");
  assert.equal(readFileSync(join(context.dst, "user-skill/notes.md"), "utf8"), "user notes\n");
  assert.equal(readFileSync(join(context.dst, "loose-file.txt"), "utf8"), "user file\n");
});

test("the no-rsync fallback also refreshes and prunes owned skill trees", (t) => {
  const context = fixture({
    "hub/SKILL.md": "v1\n",
    "hub/references/a.md": "old\n",
    "hub/references/stale.md": "stale\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  writeTree(context.dst, { "user-skill/SKILL.md": "user\n" });

  const first = register(context, { ANDROID_MCP_SKILL_COPY: "copy" });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  writeFileSync(join(context.src, "hub/references/a.md"), "new\n");
  writeFileSync(join(context.src, "hub/references/b.md"), "added\n");
  rmSync(join(context.src, "hub/references/stale.md"));

  const second = register(context, { ANDROID_MCP_SKILL_COPY: "copy" });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(readFileSync(join(context.dst, "hub/references/a.md"), "utf8"), "new\n");
  assert.ok(existsSync(join(context.dst, "hub/references/b.md")));
  assert.ok(!existsSync(join(context.dst, "hub/references/stale.md")));
  assert.equal(readFileSync(join(context.dst, "user-skill/SKILL.md"), "utf8"), "user\n");
});

test("a failed sync is reported and never claims success", (t) => {
  const context = fixture({
    "hub/SKILL.md": "hub\n",
    "other/SKILL.md": "other\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  const fakeBin = join(context.root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "rsync"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

  const result = register(context, {}, fakeBin);
  assert.notEqual(result.status, 0, "registration must fail when copies fail");
  assert.match(result.stderr + result.stdout, /FAILED/);
  assert.match(result.stderr + result.stdout, /hub/);
  assert.doesNotMatch(result.stdout, /Installed\/refreshed \d+ skills/);
  assert.ok(
    !existsSync(join(context.dst, ".android-mcp-manifest")),
    "failed registration must not write a success manifest",
  );
});

posixTest("the no-rsync fallback also refuses to claim success when copying fails", (t) => {
  const context = fixture({
    "hub/SKILL.md": "hub\n",
  });
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  const fakeBin = join(context.root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "cp"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });

  const result = register(context, { ANDROID_MCP_SKILL_COPY: "copy" }, fakeBin);
  assert.notEqual(result.status, 0, "registration must fail when the fallback copy fails");
  assert.match(result.stderr + result.stdout, /FAILED/);
  assert.doesNotMatch(result.stdout, /Installed\/refreshed \d+ skills/);
  assert.ok(
    !existsSync(join(context.dst, ".android-mcp-manifest")),
    "failed registration must not write a success manifest",
  );
});
