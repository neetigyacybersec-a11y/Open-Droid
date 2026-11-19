// FR-R23 privacy inventory tests. Fixtures are written to a temp project so the
// scanner is exercised through the same filesystem path an Android app uses.
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { piiIdentifiers, renderPrivacyReport, scanPrivacyProject } from "../dist/privacy.js";
import { handlePrivacyScan } from "../dist/tools.js";

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "privacy-test-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="android.permission.CAMERA" />
</manifest>`;

const gradle = `[libraries]
firebase-analytics = { module = "com.google.firebase:firebase-analytics" }
ads = { module = "com.google.android.gms:play-services-ads" }
`;

test("inventories permissions, SDKs, endpoints and on-device storage", async (t) => {
  const root = await fixture({
    "app/src/main/AndroidManifest.xml": manifest,
    "gradle/libs.versions.toml": gradle,
    "app/src/main/java/com/example/Main.kt": `package com.example

class Main {
    fun load(context: Context) {
        val base = "https://api.example.com/v1"
        val prefs: SharedPreferences = context.getSharedPreferences("user", 0)
    }
}
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.deepEqual(result.permissions, ["CAMERA", "INTERNET"]);
  assert.ok(result.sdks.some((sdk) => sdk.artifact === "com.google.firebase:firebase-analytics"));
  assert.ok(result.sdks.some((sdk) => sdk.artifact === "com.google.android.gms:play-services-ads"));
  assert.ok(result.endpoints.some((endpoint) => endpoint.host === "api.example.com"));
  assert.ok(result.dataStores.some((store) => store.kind === "SharedPreferences"));
  assert.ok(result.candidateDataTypes.includes("photos"));
  assert.ok(result.candidateDataTypes.includes("advertising ID"));
  assert.match(renderPrivacyReport(result), /# Privacy inventory/);
});

test("flags PII in log calls and ignores constant text and comments", async (t) => {
  const root = await fixture({
    "app/src/main/java/com/example/Logs.kt": `package com.example

fun log(email: String, token: String, count: Int, password: String) {
    Log.d("Auth", "email=$email")
    Log.d("Auth", "token count: $count")
    Log.d("Auth", "email sent")
    println("Authorization: Bearer $token")
    Log.d("Auth", "user=\${user.email}")
    // Log.d("Auth", "password=$password")
}
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.equal(result.piiLogs.length, 3);
  assert.ok(result.piiLogs.some((log) => log.identifiers.includes("email")));
  assert.ok(result.piiLogs.some((log) => log.identifiers.includes("token")));
  assert.ok(result.piiLogs.every((log) => !log.snippet.includes("password=")));
  assert.ok(
    result.findings.some((finding) => finding.rule === "pii-log" && finding.severity === "blocker"),
  );
});

test("piiIdentifiers only reports identifier-like PII, not string text", () => {
  assert.deepEqual(piiIdentifiers('"email sent"'), []);
  assert.deepEqual(piiIdentifiers('TAG, "email=$email"'), ["email"]);
  assert.deepEqual(piiIdentifiers('TAG, "count=$count"'), []);
  assert.deepEqual(piiIdentifiers('TAG, "cipher=\${CryptoBox.encrypt("demo-secret")}"'), []);
  assert.deepEqual(piiIdentifiers("TAG, user.email"), ["email", "user"]);
});

test("blocks account creation without an account deletion marker", async (t) => {
  const root = await fixture({
    "app/src/main/java/com/example/Account.kt": `package com.example

fun create() {
    auth.createUserWithEmailAndPassword(email, password)
}
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.equal(result.accountCreation.length, 1);
  assert.equal(result.accountDeletion.length, 0);
  assert.ok(
    result.findings.some(
      (finding) => finding.rule === "account-deletion-gap" && finding.severity === "blocker",
    ),
  );
});

test("accepts declarations that match observed signals", async (t) => {
  const root = await fixture({
    "app/src/main/AndroidManifest.xml": manifest,
    "gradle/libs.versions.toml": gradle,
    "app/src/main/java/com/example/Main.kt": `package com.example

class Main {
    fun endpoints() {
        val base = "https://api.example.com/v1"
    }
    fun account() {
        createAccount()
        deleteAccount()
    }
}
`,
    "privacy/data-safety.json": JSON.stringify({
      permissions: ["INTERNET", "CAMERA"],
      sdks: ["com.google.firebase:firebase-analytics", "com.google.android.gms:play-services-ads"],
      endpoints: ["api.example.com"],
      accountCreation: true,
      accountDeletion: true,
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.ok(result.declarationsCheck);
  assert.equal(result.declarationsCheck.ok, true);
  assert.equal(result.declarationsCheck.undeclaredPermissions.length, 0);
  assert.equal(result.declarationsCheck.undeclaredSdks.length, 0);
  assert.equal(result.declarationsCheck.undeclaredEndpoints.length, 0);
  assert.equal(result.declarationsCheck.accountDeletionGap, false);
  assert.equal(result.findings.filter((finding) => finding.severity === "blocker").length, 0);
});

test("reports declaration mismatches as evidence", async (t) => {
  const root = await fixture({
    "app/src/main/AndroidManifest.xml": manifest,
    "gradle/libs.versions.toml": gradle,
    "app/src/main/java/com/example/Main.kt": `package com.example

class Main {
    fun endpoints() {
        val base = "https://api.example.com/v1"
    }
    fun account() {
        createAccount()
        deleteAccount()
    }
}
`,
    "privacy/data-safety.json": JSON.stringify({
      permissions: ["INTERNET"],
      sdks: [],
      endpoints: ["other.example.com"],
      accountCreation: false,
      accountDeletion: false,
    }),
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  const check = result.declarationsCheck;
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.deepEqual(check.undeclaredPermissions, ["CAMERA"]);
  assert.deepEqual(check.undeclaredSdks, [
    "com.google.android.gms:play-services-ads",
    "com.google.firebase:firebase-analytics",
  ]);
  assert.deepEqual(check.undeclaredEndpoints, ["api.example.com"]);
  assert.deepEqual(check.staleEndpoints, ["other.example.com"]);
  assert.equal(check.accountCreationUndeclared, true);
  assert.equal(check.accountDeletionUndeclared, true);
  assert.ok(
    result.findings.some(
      (finding) => finding.rule === "permissions-undeclared" && finding.severity === "blocker",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.rule === "sdks-undeclared" && finding.severity === "blocker",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.rule === "endpoints-undeclared" && finding.severity === "blocker",
    ),
  );
});

test("ignores build output and commented log calls", async (t) => {
  const root = await fixture({
    "app/build/generated/Leak.kt": `fun leak(token: String) { Log.d("x", "token=$token") }\n`,
    "app/src/main/java/com/example/Main.kt": `package com.example

fun safe() {
    // Log.d("x", "token=\${token}")
    Log.d("x", "started")
}
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.equal(result.piiLogs.length, 0);
});

test("missing explicit declarations are a blocker", async (t) => {
  const root = await fixture({
    "app/src/main/java/com/example/Main.kt": `package com.example\n\nfun safe() { Log.d("x", "started") }\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root, { declarationsPath: "privacy/missing.json" });
  assert.equal(result.declarations, null);
  assert.equal(result.declarationsRequired, true);
  assert.ok(
    result.findings.some(
      (finding) => finding.rule === "declarations-missing" && finding.severity === "blocker",
    ),
  );
});

test("the MCP handler writes a report and honors strict mode", async (t) => {
  const root = await fixture({
    "app/src/main/java/com/example/Main.kt": `package com.example\n\nfun leak(token: String) { Log.d("x", "token=$token") }\n`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = join(root, "privacy", "privacy-scan.md");

  const strict = await handlePrivacyScan({ projectPath: root, reportPath, strict: true });
  assert.equal(strict.isError, true);
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /# Privacy inventory/);
  assert.match(report, /pii-log/);

  const lenient = await handlePrivacyScan({ projectPath: root, strict: false });
  assert.equal(lenient.isError, false);
});

test("inventories resource strings and buildConfigField URLs with evidence classes", async (t) => {
  const root = await fixture({
    "app/src/main/res/values/strings.xml": `<resources>
  <string name="source_url">https://strings.example.com/v1</string>
  <string-array name="endpoints">
    <item>https://array.example.com/v2</item>
  </string-array>
  <!-- <string name="old">https://commented.example.com</string> -->
</resources>
`,
    "app/build.gradle.kts": `android {
  defaultConfig {
    buildConfigField("String", "API_URL", "\\"https://build.example.com/v3\\"")
    // buildConfigField("String", "OLD", "\\"https://commented-build.example.com\\"")
  }
}
`,
    "app/src/main/java/com/example/Main.kt": `package com.example
class Main {
    val endpoint = "https://source.example.com/api"
    // val old = "https://commented-source.example.com"
}
`,
    "app/src/main/AndroidManifest.xml": manifest,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  const hosts = new Set(result.endpoints.map((endpoint) => endpoint.host));
  assert.ok(hosts.has("strings.example.com"));
  assert.ok(hosts.has("array.example.com"));
  assert.ok(hosts.has("build.example.com"));
  assert.ok(hosts.has("source.example.com"));
  assert.ok(!hosts.has("commented.example.com"));
  assert.ok(!hosts.has("commented-build.example.com"));
  assert.ok(!hosts.has("commented-source.example.com"));

  const resource = result.endpoints.find((endpoint) => endpoint.host === "strings.example.com");
  const build = result.endpoints.find((endpoint) => endpoint.host === "build.example.com");
  const source = result.endpoints.find((endpoint) => endpoint.host === "source.example.com");
  assert.equal(resource.source, "resource-value");
  assert.equal(build.source, "build-config");
  assert.equal(source.source, "source-code");
  assert.ok(result.coverage.filesByCategory["resource-xml"] >= 1);
  assert.ok(result.coverage.filesByCategory["build-config"] >= 1);
  assert.ok(result.coverage.filesByCategory["source-code"] >= 1);

  const report = renderPrivacyReport(result);
  assert.match(report, /Files by category: .*build-config=/);
  assert.match(report, /Files by category: .*resource-xml=/);
  assert.match(report, /Files by category: .*source-code=/);
  assert.match(report, /Not inspected by this static scan:/);
  assert.match(report, /Transitive dependencies: not assessed/);
});

test("retains every evidence path for duplicate endpoints", async (t) => {
  const root = await fixture({
    "app/src/main/res/values/strings.xml": `<resources>
  <string name="api">https://shared.example.com/v1</string>
</resources>
`,
    "app/src/main/java/com/example/Main.kt": `package com.example
class Main { val api = "https://shared.example.com/v1" }
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  const shared = result.endpoints.filter((endpoint) => endpoint.host === "shared.example.com");
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map((endpoint) => endpoint.source).sort(), [
    "resource-value",
    "source-code",
  ]);
  assert.deepEqual(shared.map((endpoint) => endpoint.file).sort(), [
    "app/src/main/java/com/example/Main.kt",
    "app/src/main/res/values/strings.xml",
  ]);
});

test("inspects an existing merged manifest and separates its permissions", async (t) => {
  const root = await fixture({
    "app/src/main/AndroidManifest.xml": manifest,
    "app/build/intermediates/merged_manifest/debug/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <uses-permission android:name="com.google.android.gms.permission.AD_ID" />
</manifest>
`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root);
  assert.equal(result.coverage.mergedManifest, "inspected");
  const merged = result.permissionEvidence.filter((entry) => entry.source === "manifest-merged");
  assert.ok(merged.some((entry) => entry.permission === "AD_ID"));
  assert.ok(merged.some((entry) => entry.permission === "INTERNET"));
  assert.ok(
    result.permissionEvidence.some(
      (entry) => entry.permission === "INTERNET" && entry.source === "manifest-source",
    ),
  );
  assert.match(renderPrivacyReport(result), /Merged manifest: inspected/);
});

test("reports coverage limits and never claims absence beyond inspected sources", async (t) => {
  const root = await fixture({
    "app/src/main/AndroidManifest.xml": manifest,
    "app/src/main/java/com/example/Main.kt": `package com.example
class Main { val greeting = "hello" }
`,
    "app/src/main/java/com/example/Oversized.kt": `package com.example\nval api = "https://hidden.example.com"\n${"x".repeat(200)}`,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await scanPrivacyProject(root, { maxFiles: 2, maxFileBytes: 100 });
  assert.equal(result.limitReached, true);
  assert.ok(result.coverage.oversizedFiles >= 1);
  assert.ok(!result.endpoints.some((endpoint) => endpoint.host === "hidden.example.com"));
  assert.equal(result.coverage.dependencyResolution, "not-run");
  assert.equal(result.coverage.transitiveDependencies, "not-assessed");
  assert.equal(result.coverage.mergedManifest, "not-found");
  assert.ok(result.coverage.unsupportedSources.length > 0);
  assert.ok(result.findings.some((finding) => finding.rule === "scan-limit"));

  const report = renderPrivacyReport(result);
  assert.match(report, /No network endpoints detected in inspected sources/);
  assert.match(report, /not a compliance certificate/i);
  assert.match(report, /Gradle dependency resolution: not run/);
  assert.match(report, /transitive dependencies are not assessed/i);
});
