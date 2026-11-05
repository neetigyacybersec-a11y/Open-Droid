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
  assert.ok(result.findings.some((finding) => finding.rule === "pii-log" && finding.severity === "blocker"));
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
  assert.ok(result.findings.some((finding) => finding.rule === "account-deletion-gap" && finding.severity === "blocker"));
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
  assert.ok(result.findings.some((finding) => finding.rule === "permissions-undeclared" && finding.severity === "blocker"));
  assert.ok(result.findings.some((finding) => finding.rule === "sdks-undeclared" && finding.severity === "blocker"));
  assert.ok(result.findings.some((finding) => finding.rule === "endpoints-undeclared" && finding.severity === "blocker"));
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
  assert.ok(result.findings.some((finding) => finding.rule === "declarations-missing" && finding.severity === "blocker"));
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
