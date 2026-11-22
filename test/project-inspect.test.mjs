// ISSUE-23: deterministic, read-only project inventory from Gradle files and
// a bounded filesystem fallback. Never executes builds or returns secret values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProject } from "../dist/projectInspect.js";
import { TOOL_REGISTRY } from "../dist/registry.js";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "od-project-inspect-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(target.slice(0, target.lastIndexOf("/")) || root, { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function snapshot(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [e.name],
    );
  return walk(root).sort();
}

const MULTI_MODULE = {
  "settings.gradle.kts":
    'rootProject.name = "demo"\ninclude(":app", ":lib")\nincludeBuild("tools")\n',
  "build.gradle.kts":
    'plugins { id("com.android.application") version "8.7.2" apply false }\n',
  "gradle/libs.versions.toml": "[libraries]\n",
  "app/build.gradle.kts": `plugins {
    id("com.android.application")
}
android {
    compileSdk = 36
    defaultConfig { minSdk = 24; targetSdk = 36; applicationId = "com.demo.app" }
}
namespace = "com.demo.app"
versionCode = 42
versionName = "1.4.2"
`,
  "app/src/main/AndroidManifest.xml": `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET"/>
</manifest>`,
  "app/src/main/java/com/demo/App.kt": "class App\n",
  "lib/build.gradle.kts": 'plugins { id("com.android.library") }\nandroid {\n    compileSdkVersion 34\n}\n',
  "lib/src/main/res/values/strings.xml": `<resources><string name="app_name">Demo</string></resources>`,
};

const LIBRARY_FIXTURE = {
  "settings.gradle": 'rootProject.name = "lib-only"\ninclude(":lib")\n',
  "lib/build.gradle":
    'plugins { apply plugin: "com.android.library" }\nandroid {\n    compileSdkVersion(33)\n    targetSdkVersion 33\n}\n',
  "lib/src/main/java/a/B.java": "class B {}\n",
};

const FLAVORS_FIXTURE = {
  "settings.gradle.kts": 'rootProject.name = "flavored"\ninclude(":app")\n',
  "app/build.gradle.kts": `plugins { id("com.android.application") }
android {
    compileSdk = 35
    productFlavors {
        free { dimension = "tier" }
        paid { dimension = "tier" }
    }
    buildTypes {
        release { isMinifyEnabled = true }
        create("beta")
    }
}
`,
  "app/src/main/java/F.kt": "class F\n",
};

const MISSING_SDK_FIXTURE = {
  "settings.gradle.kts": 'include(":app")\n',
  "app/build.gradle.kts": 'plugins { id("com.android.application") }\n',
};

const MALFORMED_FIXTURE = {
  "settings.gradle.kts": "<<< not gradle >>>\n{ unbalanced",
};

test("multi-module inventory: modules, types, SDK and source roots", () => {
  const root = fixture(MULTI_MODULE);
  try {
    const report = inspectProject({ projectPath: root });
    assert.equal(report.status, "ok");
    assert.equal(report.projectType, "android-application");
    assert.equal(report.rootProjectName, "demo");
    const app = report.modules.find((m) => m.path === "app");
    assert.ok(app, "app module present");
    assert.equal(app.type, "android-application");
    assert.equal(app.sdk.compileSdk, "36");
    assert.equal(app.sdk.minSdk, "24");
    assert.equal(app.sdk.targetSdk, "36");
    assert.equal(app.sdk.namespace, "com.demo.app");
    assert.equal(app.sdk.applicationId, "com.demo.app");
    assert.equal(app.sdk.versionCode, "42");
    assert.equal(app.sdk.versionName, "1.4.2");
    assert.ok(app.sourceSets.main.some((dir) => dir.endsWith("app/src/main/java")), "main/java dir");
    assert.ok(app.manifests.some((dir) => dir.endsWith("AndroidManifest.xml")), "manifest listed");
    const lib = report.modules.find((m) => m.path === "lib");
    assert.ok(lib, "lib module present");
    assert.equal(lib.type, "android-library");
    assert.equal(lib.sdk.compileSdk, "34", "compileSdkVersion(34) parses");
    assert.equal(report.catalogPath, join(root, "gradle/libs.versions.toml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("library fixture yields a single library module", () => {
  const root = fixture(LIBRARY_FIXTURE);
  try {
    const report = inspectProject({ projectPath: root });
    assert.equal(report.projectType, "android-library");
    assert.deepEqual(report.modules.map((m) => m.path).sort(), ["lib"]);
    assert.equal(report.modules[0].type, "android-library");
    assert.equal(report.modules[0].sdk.targetSdk, "33");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flavors and build types are reported from build files", () => {
  const root = fixture(FLAVORS_FIXTURE);
  try {
    const app = inspectProject({ projectPath: root }).modules.find((m) => m.path === "app");
    assert.deepEqual(app.productFlavors.sort(), ["free", "paid"]);
    assert.deepEqual(app.buildTypes.sort(), ["beta", "release"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing SDK fields are unknown, not guessed", () => {
  const root = fixture(MISSING_SDK_FIXTURE);
  try {
    const app = inspectProject({ projectPath: root }).modules.find((m) => m.path === "app");
    assert.equal(app.sdk.compileSdk, null);
    assert.equal(app.sdk.minSdk, null);
    assert.ok(app.sdk.unknowns.length > 0, "unknown SDK fields are recorded");
    assert.ok(app.sdk.unknowns.every((u) => u.source.includes("build.gradle.kts")));
    assert.ok(app.type === "android-application", "plugin still detected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed Gradle files produce errors, never a build or guesses", () => {
  const root = fixture(MALFORMED_FIXTURE);
  try {
    const report = inspectProject({ projectPath: root });
    assert.equal(report.status, "ok");
    assert.ok(report.errors.length > 0, "parse problems recorded");
    assert.equal(report.modules.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret-bearing files are listed by name but values never appear", () => {
  const root = fixture({
    ...MULTI_MODULE,
    "local.properties": "keystoreAlias=mykey\nkeystore.password=supersecret123\n",
    "app/local.properties": "storePassword=supersecret456\n",
  });
  try {
    const report = inspectProject({ projectPath: root });
    assert.ok(report.secrets.includes("local.properties"));
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /supersecret(123|456)/);
    assert.doesNotMatch(serialized, /keystore\.password|storePassword|keystoreAlias/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspection is read-only and deterministic", () => {
  const root = fixture(MULTI_MODULE);
  try {
    const before = snapshot(root);
    const a = inspectProject({ projectPath: root });
    const b = inspectProject({ projectPath: root });
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing project path is an explicit error", () => {
  const root = mkdtempSync(join(tmpdir(), "od-project-inspect-"));
  try {
    const missing = inspectProject({ projectPath: join(root, "nope") });
    assert.equal(missing.status, "error");
    assert.ok(missing.reason, "reason recorded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry registers android_project_inspect as a read-only project tool", () => {
  const entry = TOOL_REGISTRY.find((t) => t.name === "android_project_inspect");
  assert.ok(entry, "android_project_inspect is registered");
  assert.equal(entry.risk, "read-only");
  assert.equal(entry.approval, "none");
  assert.equal(entry.unattended, true);
  assert.ok(entry.sideEffects.includes("host-read"));
  assert.ok(!entry.sideEffects.includes("host-write"));
  assert.ok(entry.paths.some((p) => p.field === "projectPath"));
});
