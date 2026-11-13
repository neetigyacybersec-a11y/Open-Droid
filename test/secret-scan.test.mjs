// ISSUE #36 slice 1: project secret scanning.
// Fixtures are written to a temp project so no fake credentials live in the
// repo. The scan result must never contain a raw secret — several tests assert
// directly on the JSON-serialized result.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scanProjectSecrets } from "../dist/secretScan.js";

const GOOGLE_KEY = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GITHUB_TOKEN = "ghp" + "_1234567890abcdefghijklmnopqrstuvwxyz";
const SLACK_TOKEN = "xoxb" + "-123456789012-abcdefghijklmnop";
const GENERIC_SECRET = "s3cr3t-P@ssw0rd-9xQ";
const PEM_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "secret-scan-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

const riskyFiles = {
  "app/build.gradle.kts": `android {\n  signingConfigs {\n    create("release") {\n      storePassword = "${GENERIC_SECRET}"\n      keyAlias = "release"\n    }\n  }\n}\n`,
  "app/src/main/java/com/example/Keys.kt": `package com.example\n\nconst val AWS_KEY = "${AWS_KEY}"\nconst val GH = "${GITHUB_TOKEN}"\nconst val SLACK = "${SLACK_TOKEN}"\nconst val GOOGLE = "${GOOGLE_KEY}"\n`,
  "config/api.properties": `# service config\napi.key=${GENERIC_SECRET}\n`,
  "keys/server.pem": `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----\n`,
  "app/release.jks": "binary-keystore-placeholder",
  "app/build/outputs/apk/release/app-release.apk": "PK\u0003\u0004binary",
};

test("detects known provider token formats with file/line evidence", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    const byRule = (rule) => result.findings.filter((f) => f.rule === rule);
    assert.equal(byRule("google-api-key").length, 1);
    assert.equal(byRule("aws-access-key").length, 1);
    assert.equal(byRule("github-token").length, 1);
    assert.equal(byRule("slack-token").length, 1);

    const google = byRule("google-api-key")[0];
    assert.equal(google.severity, "high");
    assert.equal(google.confidence, "confirmed");
    assert.match(google.file, /Keys\.kt$/);
    assert.ok(google.line >= 1);
    assert.ok(google.column >= 1);
    assert.ok(google.remediation.length > 0);
    assert.match(google.snippet, /\[REDACTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PEM private key blocks are critical, reported once with a redacted path-level finding", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    const keys = result.findings.filter((f) => f.rule === "private-key-block");
    assert.equal(keys.length, 1);
    assert.equal(keys[0].severity, "critical");
    assert.match(keys[0].file, /server\.pem$/);
    assert.match(keys[0].snippet, /REDACTED/);
    assert.doesNotMatch(keys[0].snippet, new RegExp(PEM_BODY.slice(0, 16)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic credentials and keystore passwords are detected", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    const generic = result.findings.filter((f) => f.rule === "generic-credential");
    assert.ok(generic.length >= 2, "gradle storePassword and api.key must both be flagged");
    assert.ok(generic.some((f) => /build\.gradle\.kts$/.test(f.file)));
    assert.ok(generic.some((f) => /api\.properties$/.test(f.file)));
    assert.ok(generic.every((f) => f.severity === "medium"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redaction is absolute: no raw secret value appears anywhere in the result", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    const serialized = JSON.stringify(result);
    for (const secret of [
      GOOGLE_KEY,
      AWS_KEY,
      GITHUB_TOKEN,
      SLACK_TOKEN,
      GENERIC_SECRET,
      PEM_BODY,
    ]) {
      assert.ok(
        !serialized.includes(secret),
        `raw secret leaked into the scan result: ${secret.slice(0, 6)}…`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary files and keystores are excluded and reported by path only", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    const joined = result.excludedPaths.join("\n");
    assert.match(joined, /release\.jks$/);
    // build/ is excluded wholesale before its files are visited, so the
    // directory is reported (never the APK contents).
    assert.ok(
      joined.split("\n").includes("app/build"),
      "the build directory must be reported as excluded",
    );
    assert.ok(result.findings.every((f) => !/\.jks$|\.apk$/.test(f.file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allowlist moves matching findings out of the report with its rationale", async () => {
  const root = await fixture({
    ...riskyFiles,
    ".secretallowlist.json": JSON.stringify([
      {
        rule: "google-api-key",
        file: "app/src/main/java/com/example/Keys.kt",
        rationale: "public client id",
      },
    ]),
  });
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    assert.equal(result.findings.filter((f) => f.rule === "google-api-key").length, 0);
    assert.equal(result.allowlist.length, 1);
    assert.equal(result.allowlist[0].rule, "google-api-key");
    assert.match(result.allowlist[0].rationale, /public client id/);
    assert.ok(result.findings.some((f) => f.rule === "aws-access-key"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("severityThreshold filters lower-severity findings", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root, severityThreshold: "critical" });
    assert.ok(result.findings.length >= 1);
    assert.ok(result.findings.every((f) => f.severity === "critical"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("env indirection, property lookups and credential references are not false positives", async () => {
  const root = await fixture({
    "app/src/main/java/com/example/Safe.kt": `val password = System.getenv("APP_PASSWORD")\nval token = BuildConfig.API_TOKEN\nval password2 = credential.password\n`,
    "app/build.gradle.kts": `android {\n  signingConfigs {\n    create("release") {\n      storePassword = keystoreProps.getProperty("storePassword")\n      keyPassword = providers.environmentVariable("KEY_PASSWORD").get()\n    }\n  }\n}\n`,
  });
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vendored toolchain trees are excluded from the scan", async () => {
  const root = await fixture({
    ".toolchain/android-sdk/notes.txt": `api.key=s3cr3t-P@ssw0rd-9xQ\n`,
    "app/src/main/java/com/example/Hello.kt": `val greeting = "hello"\n`,
  });
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    assert.deepEqual(result.findings, []);
    assert.ok(result.excludedPaths.includes(".toolchain"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked status is best-effort: null outside a git repo", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    assert.ok(result.findings.every((f) => f.tracked === null));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a scanned clean project yields no findings and a scannedAt stamp", async () => {
  const root = await fixture({
    "app/src/main/java/com/example/Hello.kt": `val greeting = "hello"\n`,
  });
  try {
    const result = await scanProjectSecrets({ projectPath: root });
    assert.deepEqual(result.findings, []);
    assert.ok(result.scannedFiles >= 1);
    assert.ok(result.scannedAt.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Keep execFileSync referenced so the helper import is intentional if extended
// later for git-tracked fixtures.
void execFileSync;
