// ISSUE-168: the host MCP runs Android/JVM tools in a toolchain container when
// configured. These are pure argv/config checks; no Docker daemon is needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  TOOLCHAIN_COMMANDS,
  containerInvocation,
  isRemoteDockerEndpoint,
  toolchainCommand,
  toolchainImage,
  toolchainMode,
  toolchainMounts,
} from "../dist/services/toolchain.js";
import { resolveGradleExecutable } from "../dist/gradleExecutable.js";

const REPO = resolve(import.meta.dirname, "..");
// Windows container mode is fail-closed; POSIX mount/argv checks are not
// meaningful there (drive-letter paths are not identity-mounted).
const posixTest = process.platform === "win32" ? test.skip : test;

test("container mode is opt-in and host mode is the default", () => {
  assert.equal(toolchainMode({}), "host");
  assert.equal(toolchainImage({}), null);
  assert.equal(toolchainMode({ ANDROID_MCP_TOOLCHAIN_IMAGE: "  " }), "host");
  assert.equal(toolchainMode({ ANDROID_MCP_TOOLCHAIN_IMAGE: "open-droid:1" }), "docker");
});

test("only Android/JVM toolchain commands are routed; device tools stay host-side", () => {
  assert.ok(TOOLCHAIN_COMMANDS.includes("gradle"));
  assert.equal(toolchainCommand("/opt/toolchain/gradle"), "gradle");
  assert.equal(toolchainCommand("/venv/bin/frida-ps"), "frida-ps");
  assert.equal(toolchainCommand("compose-preview"), "compose-preview");
  for (const host of ["adb", "emulator", "git", "ps", "unzip", "strings", "where"]) {
    assert.equal(toolchainCommand(host), null, `${host} must not be routed`);
  }
});

posixTest("docker argv mounts the workspace without building a shell string", () => {
  const cwd = mkdtempSync(join(tmpdir(), "od-toolchain-"));
  try {
    const inv = containerInvocation("gradle", ["assembleDebug", "--offline"], {
      image: "open-droid:1",
      platform: "linux",
      cwd,
      env: { ANDROID_SERIAL: "emulator-5554", PATH: "/usr/bin" },
    });
    assert.ok(inv?.ok);
    assert.equal(inv.command, "docker");
    assert.deepEqual(inv.args.slice(0, 3), ["run", "--rm", "--init"]);
    const joined = inv.args.join(" ");
    assert.ok(inv.args.includes(`${cwd}:${cwd}`), "cwd is bind-mounted read-write");
    assert.ok(inv.args.includes("-w") && inv.args.includes(cwd), "cwd is the working directory");
    const mounts = toolchainMounts(cwd, { PATH: "/usr/bin" });
    const tmpIndex = mounts.findIndex((mount) => mount.source === resolve(tmpdir()));
    const cwdIndex = mounts.findIndex((mount) => mount.source === cwd);
    assert.ok(tmpIndex >= 0 && cwdIndex > tmpIndex, "parents mount before nested project paths");
    assert.match(joined, /-e ANDROID_SERIAL=emulator-5554/);
    assert.deepEqual(inv.args.slice(inv.args.indexOf("open-droid:1")), [
      "open-droid:1",
      "gradle",
      "assembleDebug",
      "--offline",
    ]);
    assert.ok(!joined.includes("sh -c"), "arguments must not pass through a shell");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("mounts keep the repo read-only and exclude the host toolchain", () => {
  const mounts = toolchainMounts(undefined, { PATH: "/usr/bin" });
  const repo = mounts.find((mount) => mount.source === REPO);
  assert.ok(repo, "repo root is mounted for frida scripts");
  assert.equal(repo.readOnly, true);
  assert.ok(
    !mounts.some((mount) => mount.source.includes("/.toolchain")),
    "host toolchain is not mounted",
  );
});

test("Windows fails closed instead of silently using host tools", () => {
  const inv = containerInvocation("gradle", ["assembleDebug"], {
    image: "open-droid:1",
    platform: "win32",
  });
  assert.equal(inv?.ok, false);
  assert.match(inv.message, /Windows/);
  assert.match(inv.message, /No fallback/);
});

test("remote Docker daemons are detected: their mounts are not the MCP host's", () => {
  assert.equal(isRemoteDockerEndpoint("unix:///var/run/docker.sock"), false);
  assert.equal(isRemoteDockerEndpoint("npipe:////./pipe/docker_engine"), false);
  assert.equal(isRemoteDockerEndpoint("tcp://127.0.0.1:2375"), false);
  assert.equal(isRemoteDockerEndpoint("tcp://localhost:2375"), false);
  assert.equal(isRemoteDockerEndpoint("ssh://builder@192.168.1.85"), true);
  assert.equal(isRemoteDockerEndpoint("tcp://192.168.1.85:2375"), true);
});

test("an empty image reference is an error, not a host fallback", () => {
  const inv = containerInvocation("jadx", ["--version"], { image: "" });
  assert.equal(inv?.ok, false);
  assert.match(inv.message, /ANDROID_MCP_TOOLCHAIN_IMAGE/);
});

test("Gradle resolves from the image in container mode", () => {
  const ok = resolveGradleExecutable({
    env: { ANDROID_MCP_TOOLCHAIN_IMAGE: "open-droid:1", PATH: "" },
    platform: "linux",
    root: REPO,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.executable.source, "container");
  assert.equal(ok.executable.path, "gradle");
  assert.deepEqual(ok.executable.argsPrefix, []);

  const win = resolveGradleExecutable({
    env: { ANDROID_MCP_TOOLCHAIN_IMAGE: "open-droid:1", PATH: "" },
    platform: "win32",
    root: REPO,
  });
  assert.equal(win.ok, false);
  assert.match(win.message, /Windows/);
});
