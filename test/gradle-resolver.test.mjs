// ISSUE-146: one Gradle resolver for every Gradle-backed handler. Explicit
// env homes win, the bundled .toolchain distribution comes next, then
// GRADLE_HOME and finally PATH. Windows .bat launchers go through cmd.exe with
// quoted argv, never a raw concatenated shell command.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const work = mkdtempSync(join(tmpdir(), "gradle-resolver-"));
const { test } = await import("node:test");
const { resolveGradleExecutable, gradleArgv, batchCommandLine, runGradle } =
  await import("../dist/gradleExecutable.js");
function home(name, { bat = false } = {}) {
  const dir = join(work, name);
  mkdirSync(join(dir, "bin"), { recursive: true });
  const file = join(dir, "bin", bat ? "gradle.bat" : "gradle");
  writeFileSync(file, bat ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  if (!bat) chmodSync(file, 0o755);
  return dir;
}
function resolve(overrides = {}) {
  return resolveGradleExecutable({
    platform: "linux",
    env: { PATH: "" },
    root: join(work, "empty-root"),
    ...overrides,
  });
}
test.after(() => rmSync(work, { recursive: true, force: true }));
test("explicit env homes take precedence over bundled, GRADLE_HOME and PATH", () => {
  const bundled = home("bundled");
  const mcp = home("mcp-home");
  const android = home("android-home");
  const conventional = home("conventional");
  const pathDir = home("path-home");
  const env = {
    PATH: pathDir + "/bin",
    ANDROID_MCP_GRADLE_HOME: mcp,
    ANDROID_GRADLE_HOME: android,
    GRADLE_HOME: conventional,
  };
  assert.deepEqual(resolve({ root: join(work, "root-b"), env }).executable, {
    command: join(mcp, "bin", "gradle"),
    argsPrefix: [],
    path: join(mcp, "bin", "gradle"),
    source: "ANDROID_MCP_GRADLE_HOME",
  });
  const noMcp = { ...env, ANDROID_MCP_GRADLE_HOME: undefined };
  assert.equal(
    resolve({ root: join(work, "root-a"), env: noMcp }).executable.source,
    "ANDROID_GRADLE_HOME",
  );
  const onlyConventional = { PATH: pathDir + "/bin", GRADLE_HOME: conventional };
  assert.equal(
    resolve({ root: join(work, "root-c"), env: onlyConventional }).executable.source,
    "GRADLE_HOME",
  );
  // The bundled distribution is used when no explicit home is set.
  const bundledRoot = join(work, "checkout");
  mkdirSync(bundledRoot, { recursive: true });
  writeFileSync(join(bundledRoot, "placeholder"), "");
  mkdirSync(join(bundledRoot, ".toolchain"), { recursive: true });
  mkdirSync(join(bundledRoot, ".toolchain", "gradle"), { recursive: true });
  mkdirSync(join(bundledRoot, ".toolchain", "gradle", "bin"), { recursive: true });
  writeFileSync(join(bundledRoot, ".toolchain", "gradle", "bin", "gradle"), "#!/bin/sh\n");
  chmodSync(join(bundledRoot, ".toolchain", "gradle", "bin", "gradle"), 0o755);
  assert.equal(resolve({ root: bundledRoot, env: { PATH: "" } }).executable.source, "bundled");
  assert.equal(
    resolve({ root: join(work, "nope"), env: { PATH: pathDir + "/bin" } }).executable.source,
    "PATH",
  );
});
test("missing installations list every resolution attempt", () => {
  const result = resolve({
    env: { PATH: "", ANDROID_MCP_GRADLE_HOME: join(work, "a") },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /make setup/);
  assert.match(result.message, /ANDROID_MCP_GRADLE_HOME/);
  assert.match(result.message, /PATH/);
});
test("Windows selects gradle.bat and wraps argv through cmd.exe with quoting", () => {
  const winHome = home("win-home", { bat: true });
  const resolution = resolveGradleExecutable({
    platform: "win32",
    env: { PATH: "", ANDROID_MCP_GRADLE_HOME: winHome },
    root: join(work, "empty"),
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.executable.source, "ANDROID_MCP_GRADLE_HOME");
  assert.match(resolution.executable.command, /cmd\.exe$/i);
  const argv = gradleArgv(["assembleDebug", "-Pout=C:\\My Project"], {
    platform: "win32",
    env: { PATH: "", ANDROID_MCP_GRADLE_HOME: winHome },
    root: join(work, "empty"),
  });
  assert.match(argv[0], /cmd\.exe$/i);
  assert.deepEqual(argv.slice(1, 4), ["/d", "/s", "/c"]);
  assert.match(argv[4], /gradle\.bat/);
  assert.match(argv[4], /"assembleDebug"/);
  assert.match(argv[4], /My Project"/);
});
test("batch quoting preserves spaces, escapes percent and rejects quotes/newlines", () => {
  assert.equal(
    batchCommandLine("C:\\Users\\My Name\\gradle.bat", ["assembleDebug", "-Ppath=C:\\A B"]),
    '"C:\\Users\\My Name\\gradle.bat" "assembleDebug" "-Ppath=C:\\A B"',
  );
  assert.match(batchCommandLine("x.bat", ["-Ptoken=%PATH%"]), /%%PATH%%/);
  assert.throws(() => batchCommandLine("x.bat", ['--x="a b"']), /quotes or control/);
  assert.throws(() => batchCommandLine("x.bat", ["a\nb"]), /quotes or control/);
});
test("runGradle executes the bundled launcher and preserves argv boundaries", async () => {
  const root = join(work, "run-root");
  const gradleDir = join(root, ".toolchain", "gradle", "bin");
  const record = join(work, "gradle-args.txt");
  mkdirSync(gradleDir, { recursive: true });
  const script = join(gradleDir, "gradle");
  writeFileSync(
    script,
    `#!/bin/sh\n: > "${record}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${record}"; done\n`,
  );
  chmodSync(script, 0o755);
  const result = await runGradle(["assembleDebug", "--offline"], { root, env: { PATH: "" } });
  assert.equal(result.code, 0);
  assert.deepEqual(readFileSync(record, "utf8").trim().split("\n"), ["assembleDebug", "--offline"]);
});

test("a sibling project keeps its path while using the bundled launcher", async () => {
  const root = join(work, "sibling-root");
  const project = join(work, "sibling-project");
  const record = join(work, "sibling-cwd.txt");
  const gradleDir = join(root, ".toolchain", "gradle", "bin");
  mkdirSync(gradleDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const script = join(gradleDir, "gradle");
  writeFileSync(script, `#!/bin/sh\npwd > "${record}"\n`);
  chmodSync(script, 0o755);
  const result = await runGradle(["tasks"], { root, cwd: project, env: { PATH: "" } });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(record, "utf8").trim(), project);
});

test("a non-executable launcher is reported among the resolution attempts", () => {
  const bad = join(work, "not-executable");
  mkdirSync(join(bad, "bin"), { recursive: true });
  writeFileSync(join(bad, "bin", "gradle"), "#!/bin/sh\n");
  chmodSync(join(bad, "bin", "gradle"), 0o644);
  const result = resolve({
    env: { PATH: "", ANDROID_MCP_GRADLE_HOME: bad },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /ANDROID_MCP_GRADLE_HOME/);
  assert.match(result.message, /no executable in bin/);
});

test("gradle handlers and android_env_check use the shared resolver", async () => {
  const homeDir = home("handler-home");
  const previous = process.env.ANDROID_MCP_GRADLE_HOME;
  process.env.ANDROID_MCP_GRADLE_HOME = homeDir;
  try {
    const { handleGradle, handleEnvCheck } = await import("../dist/tools.js");
    const project = join(work, "project");
    mkdirSync(project, { recursive: true });
    const result = await handleGradle({ projectPath: project, task: "assembleDebug" });
    assert.equal(result.isError, false);
    const env = await handleEnvCheck();
    assert.match(
      env.content[0].text,
      new RegExp(`gradle: .*handler-home.*\\(source: ANDROID_MCP_GRADLE_HOME\\)`),
    );
  } finally {
    if (previous === undefined) delete process.env.ANDROID_MCP_GRADLE_HOME;
    else process.env.ANDROID_MCP_GRADLE_HOME = previous;
  }
});
