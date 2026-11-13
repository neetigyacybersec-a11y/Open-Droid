// FR-R6 / ISSUE #38 slice 1: Play policy preflight over project source.
// Every check must carry its authoritative source and a freshness stamp, and
// unknown/conditional cases must be reported as not-assessed — never silently
// passed.
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runPolicyPreflight } from "../dist/policyPreflight.js";
import { handlePolicyPreflight, handleSecretScan, handleSecurityAudit } from "../dist/tools.js";

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "policy-preflight-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const manifest = (extra = "") => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  ${extra}
  <application android:allowBackup="false" android:networkSecurityConfig="@xml/network_security_config">
    <activity android:name=".MainActivity" android:exported="false" />
  </application>
</manifest>`;

const riskyFiles = {
  "app/build.gradle.kts": `android {\n  compileSdk = 34\n  defaultConfig {\n    targetSdk = 33\n  }\n}\ndependencies {\n  implementation("com.google.android.gms:play-services-ads:23.0.0")\n}\n`,
  "app/src/main/AndroidManifest.xml": manifest(`
  <uses-permission android:name="android.permission.USE_EXACT_ALARM" />
  <application android:allowBackup="true" android:debuggable="true">
    <service android:name=".SyncService" android:exported="false" />
    <activity android:name=".MainActivity" android:exported="true" />
  </application>`),
  "app/src/main/java/com/example/Auth.kt": `class Auth {\n  fun signUp(email: String) {}\n}\n`,
  "README.md": "# Risky app\n\nNo policy links here.\n",
};

const cleanFiles = {
  "app/build.gradle.kts": `android {\n  compileSdk = 35\n  defaultConfig {\n    targetSdk = 35\n  }\n}\n`,
  "app/src/main/AndroidManifest.xml": manifest(""),
  "app/src/main/java/com/example/Hello.kt": `val greeting = "hello"\n`,
  "privacy/data-safety.json": JSON.stringify({ dataTypes: [] }),
  "README.md": "# Clean app\n\nPrivacy policy: https://example.com/privacy\n",
};

test("risky project fails policy-sensitive checks with sourced evidence", async () => {
  const root = await fixture(riskyFiles);
  try {
    const result = await runPolicyPreflight({ projectPath: root });
    const check = (id) => result.checks.find((c) => c.id === id);

    assert.equal(check("target-sdk").status, "failed");
    assert.match(check("target-sdk").evidence, /targetSdk\s*=\s*33|targetSdkVersion\s*33/);

    assert.equal(check("data-safety-declaration").status, "failed");
    assert.equal(check("privacy-policy").status, "failed");
    assert.equal(check("account-deletion").status, "failed");
    assert.equal(check("advertising-id").status, "warning");
    assert.equal(check("foreground-service").status, "failed");
    assert.equal(check("exact-alarm").status, "warning");
    assert.equal(check("release-debuggable").status, "failed");

    for (const c of result.checks) {
      assert.match(c.sourceUrl, /^https:\/\//, `check ${c.id} must source its policy`);
      assert.match(
        c.lastVerified,
        /^\d{4}-\d{2}-\d{2}$/,
        `check ${c.id} must stamp rule freshness`,
      );
      assert.ok(c.summary.length > 0);
    }

    assert.equal(result.summary.failed, result.checks.filter((c) => c.status === "failed").length);
    assert.match(result.disclaimer, /not legal advice|does not guarantee/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clean project passes engineering checks and reports conditional ones as not-assessed", async () => {
  const root = await fixture(cleanFiles);
  try {
    const result = await runPolicyPreflight({ projectPath: root });
    const check = (id) => result.checks.find((c) => c.id === id);

    assert.equal(check("target-sdk").status, "passed");
    assert.equal(check("data-safety-declaration").status, "passed");
    assert.equal(check("privacy-policy").status, "passed");
    assert.equal(check("release-debuggable").status, "passed");
    assert.equal(check("cleartext-traffic").status, "passed");
    assert.equal(check("secrets").status, "passed");

    // Conditional checks that are not relevant must be surfaced, not passed.
    for (const id of [
      "account-deletion",
      "advertising-id",
      "billing",
      "native-abi",
      "store-listing",
    ]) {
      assert.equal(check(id).status, "not-assessed", `${id} must be not-assessed when irrelevant`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret scan findings make the preflight fail the secrets check", async () => {
  const root = await fixture({
    ...cleanFiles,
    "app/src/main/java/com/example/Keys.kt": `const val AWS_KEY = "${AWS_KEY}"\n`,
  });
  try {
    const result = await runPolicyPreflight({ projectPath: root });
    const secrets = result.checks.find((c) => c.id === "secrets");
    assert.equal(secrets.status, "failed");
    assert.match(secrets.evidence, /Keys\.kt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tool handlers wrap the scans as MCP text results", async () => {
  const root = await fixture(cleanFiles);
  try {
    const audit = await handleSecurityAudit({ projectPath: root });
    assert.equal(audit.isError, false);
    assert.match(audit.content[0].text, /AndroidManifest|findings|passed/i);

    const secrets = await handleSecretScan({ projectPath: root });
    assert.equal(secrets.isError, false);
    assert.match(secrets.content[0].text, /secret|finding|scanned/i);

    const preflight = await handlePolicyPreflight({ projectPath: root, strict: false });
    assert.equal(preflight.isError, false);
    assert.match(preflight.content[0].text, /policy|check|preflight/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
