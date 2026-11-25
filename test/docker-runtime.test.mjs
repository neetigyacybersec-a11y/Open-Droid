// ISSUE-141: the Dockerfile, versions.env and smoke scripts form one contract.
// These checks run on every host without needing a Docker daemon; CI also runs
// the image build and the in-container smoke.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(join(REPO, name), "utf8");
const versions = read("versions.env");
const dockerfile = read("Dockerfile");
const smoke = read("scripts/docker-smoke.sh");
const ci = read(".github/workflows/ci.yml");

function pin(name) {
  const match = versions.match(new RegExp(`^${name}=(.+)$`, "m"));
  assert.ok(match, `${name} missing from versions.env`);
  return match[1];
}

test("versions.env pins every non-device dependency and its upstream digest", () => {
  for (const name of [
    "GRADLE_VERSION",
    "GRADLE_SHA256",
    "MAESTRO_VERSION",
    "MAESTRO_SHA256",
    "JADX_VERSION",
    "JADX_SHA256",
    "APKTOOL_VERSION",
    "APKTOOL_SHA256",
    "COMPOSE_PREVIEW_VERSION",
    "COMPOSE_PREVIEW_SHA256",
    "FRIDA_VERSION",
    "FRIDA_TOOLS_VERSION",
    "MITMPROXY_VERSION",
    "FRIDA_SERVER_X86_64_SHA256",
    "FRIDA_SERVER_ARM64_SHA256",
    "ANDROID_CLI_URL",
  ]) {
    assert.ok(pin(name), `${name} has no value`);
  }
  for (const name of [
    "GRADLE_SHA256",
    "MAESTRO_SHA256",
    "JADX_SHA256",
    "APKTOOL_SHA256",
    "COMPOSE_PREVIEW_SHA256",
    "FRIDA_SERVER_X86_64_SHA256",
    "FRIDA_SERVER_ARM64_SHA256",
  ]) {
    assert.match(pin(name), /^[0-9a-f]{64}$/, `${name} is not a sha256`);
  }
});

test("Dockerfile installs every pinned tool and verifies its checksum", () => {
  assert.match(dockerfile, /COPY versions\.env \/app\/versions\.env/);
  assert.match(dockerfile, /COPY frida-scripts\/ \/app\/frida-scripts\//);
  assert.match(dockerfile, /\. \/app\/versions\.env/, "Dockerfile must consume the shared pins");
  assert.match(dockerfile, /GRADLE_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /JADX_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /APKTOOL_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /COMPOSE_PREVIEW_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /MAESTRO_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /FRIDA_SERVER_.*_SHA256.*sha256sum -c/s);
  assert.match(dockerfile, /pip install.*frida==\$\{FRIDA_VERSION\}/s);
  assert.match(dockerfile, /mitmproxy==\$\{MITMPROXY_VERSION\}/);
  assert.match(dockerfile, /ANDROID_CLI_URL.*\/usr\/local\/bin\/android/s);
  assert.match(dockerfile, /build-tools\/\$\{ANDROID_BUILD_TOOLS\}/);
  assert.match(dockerfile, /RUN bash scripts\/docker-smoke\.sh/);
});

test("hardcoded Dockerfile pins agree with versions.env", () => {
  assert.match(dockerfile, new RegExp(`ARG NODE_VERSION=${pin("NODE_VERSION")}$`, "m"));
  assert.match(
    dockerfile,
    new RegExp(`ENV ANDROID_BUILD_TOOLS=${pin("ANDROID_BUILD_TOOLS")}$`, "m"),
  );
});

test("the capability smoke covers every handler dependency", () => {
  for (const tool of [
    "gradle",
    "aapt2",
    "jadx",
    "apktool",
    "compose-preview",
    "android",
    "frida",
    "frida-ps",
    "mitmdump",
    "maestro",
  ]) {
    assert.match(smoke, new RegExp(`\\b${tool}\\b`), `${tool} missing from capability smoke`);
  }
  assert.match(smoke, /frida-server-\$\{FRIDA_VERSION\}-android-\$\{abi\}/);
  assert.match(smoke, /frida-scripts\/hook-method\.js/);
  assert.match(smoke, /must not ship the MCP server/);
});

test("ISSUE-168: the image is toolchain-only and starts no MCP server", () => {
  // The MCP server runs on the host; the image must not reintroduce an
  // application layer or an entrypoint that serves it.
  for (const forbidden of [
    /npm ci/,
    /npm run build/,
    /COPY --from=builder/,
    /COPY --from=toolchain/,
    /run-mcp\.sh/,
    /docker-mcp-smoke/,
    /^ENTRYPOINT/m,
    /COPY .*dist/,
  ]) {
    assert.doesNotMatch(dockerfile, forbidden, `Dockerfile must not contain ${forbidden}`);
  }
  assert.match(dockerfile, /^CMD \["sleep", "infinity"\]$/m);
  assert.match(dockerfile, /org\.opencontainers\.image\.title="open-droid-toolchain"/);
});

test("CI builds the image and runs the in-container smoke", () => {
  assert.match(ci, /^  docker:$/m);
  assert.match(ci, /(docker build -t|tags:)\s*open-droid:latest/, "CI must build the tagged image");
  assert.match(ci, /docker run --rm --entrypoint bash open-droid:latest scripts\/docker-smoke\.sh/);
});

test("device connectivity stays an explicit external boundary in the docs", () => {
  for (const name of ["README.md", "docs/agent-install.md"]) {
    const doc = read(name);
    assert.match(doc, /ADB_SERVER_SOCKET/, `${name} must document host adb connectivity`);
    assert.match(doc, /docker build -t open-droid/, `${name} lost its Docker instructions`);
  }
});
