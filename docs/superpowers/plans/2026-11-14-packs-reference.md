# Dependency-Pack Reference Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove ISSUE-17 / FR-R1 acceptance with a real project that consumes every declared dependency pack and builds, unit-tests, and compiles instrumented tests with `--offline` from the vendored Gradle cache.

**Architecture:** Add `examples/packs-reference`, a single-module Compose app that actually uses Compose, Navigation, ViewModel/StateFlow, Room, DataStore, WorkManager, Paging, Retrofit/OkHttp, kotlinx-serialization, Coil, Hilt, Turbine, Robolectric and Compose UI test. Extend the pack warmer to resolve Gradle plugin markers (the Hilt plugin is not a dependency and was never warmed). Add a proof script that copies the project to an isolated directory and runs three offline Gradle tasks; doctor reports it as a hard check.

**Tech Stack:** AGP 8.7.2, Kotlin 2.0.21, Compose BOM 2024.11.00, Hilt 2.52 (kapt), Room 2.6.1, Retrofit 2.11.0, Gradle 8.10.2 from `.toolchain`.

**Spec:** `BACKLOG.md` §3.1 FR-R1 acceptance criteria + ISSUE-17 row.

## Global Constraints

- All pins come from `manifest/packs.json`; do not invent versions for packed artifacts.
- The proof uses `GRADLE_USER_HOME=.toolchain/gradle-home` and `--offline`; it must not read `~/.gradle`.
- The project must build with the vendored `gradle` binary; no wrapper is added.
- Keep every Kotlin file small and single-purpose; this example doubles as FR-R2 reference material.
- Verification commands and their actual output go in the commit message.

## Review Focus

- A fresh host runs `make setup PACKS="app data net di test"`, disables network, then builds the reference project: the Hilt **plugin marker** must resolve, not just Hilt libraries.
- `--offline` must fail the proof if any declared artifact is missing; do not add `--continue` or ignore Gradle failures.
- Robolectric Room test must use an in-memory DB and close it, so the proof leaves no state.
- Instrumented-test compilation (`assembleDebugAndroidTest`) must be included; `assembleDebug` alone does not prove the `test` pack.
- The proof copy must exclude `build/` and `.gradle/` so a stale local build cannot mask a missing artifact.

---

### Task 1: Contract test for the reference project

**Files:**
- Create: `test/packs-reference.test.mjs`
- Modify: `package.json` (add the test file)

**Interfaces:**
- Produces: the exact expected module path `examples/packs-reference`, the offline task list `:app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest`, and source markers each later task must satisfy.

- [ ] **Step 1: Write the failing test**

```js
// FR-R1 / ISSUE-17: a warmed cache is only proven by a real consumer.
// The reference project must exercise every declared pack, not just declare it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PROJECT = path.join(REPO, "examples/packs-reference");
const read = (p) => readFileSync(path.join(PROJECT, p), "utf8");

test("packs reference project wires every dependency pack", () => {
  const appGradle = read("app/build.gradle.kts");
  for (const coordinate of [
    "androidx.navigation:navigation-compose:2.8.5",
    "androidx.room:room-runtime:2.6.1",
    "androidx.datastore:datastore-preferences:1.1.1",
    "androidx.work:work-runtime-ktx:2.10.0",
    "androidx.paging:paging-runtime-ktx:3.3.5",
    "com.squareup.retrofit2:retrofit:2.11.0",
    "com.squareup.okhttp3:okhttp:4.12.0",
    "com.google.dagger:hilt-android:2.52",
    "org.robolectric:robolectric:4.14.1",
    "app.cash.turbine:turbine:1.2.0",
  ]) {
    assert.ok(appGradle.includes(coordinate), `missing ${coordinate}`);
  }
  assert.match(appGradle, /id\("com\.google\.dagger\.hilt\.android"\)/);
  assert.match(appGradle, /kapt\("androidx\.room:room-compiler:2\.6\.1"\)/);
  assert.match(appGradle, /kapt\("com\.google\.dagger:hilt-compiler:2\.52"\)/);
});

test("packs reference project exercises every pack at compile or runtime", () => {
  const files = {
    app: read("app/src/main/java/com/example/packs/PacksApp.kt"),
    activity: read("app/src/main/java/com/example/packs/MainActivity.kt"),
    dao: read("app/src/main/java/com/example/packs/data/NoteDao.kt"),
    db: read("app/src/main/java/com/example/packs/data/AppDatabase.kt"),
    store: read("app/src/main/java/com/example/packs/data/SettingsRepository.kt"),
    worker: read("app/src/main/java/com/example/packs/data/SyncWorker.kt"),
    paging: read("app/src/main/java/com/example/packs/data/NoteRepository.kt"),
    api: read("app/src/main/java/com/example/packs/network/NoteApi.kt"),
    vm: read("app/src/main/java/com/example/packs/ui/HomeViewModel.kt"),
    ui: read("app/src/main/java/com/example/packs/ui/HomeScreen.kt"),
  };
  assert.match(files.app, /@HiltAndroidApp/);
  assert.match(files.activity, /@AndroidEntryPoint/);
  assert.match(files.activity, /NavHost/);
  assert.match(files.dao, /PagingSource/);
  assert.match(files.db, /RoomDatabase/);
  assert.match(files.store, /preferencesDataStore/);
  assert.match(files.worker, /CoroutineWorker/);
  assert.match(files.paging, /Pager|pagingSource/);
  assert.match(files.api, /@GET/);
  assert.match(files.vm, /@HiltViewModel/);
  assert.match(files.vm, /StateFlow/);
  assert.match(files.ui, /AsyncImage/);
  assert.match(files.ui, /LazyColumn/);
});

test("packs reference project ships JVM and instrumented test sources", () => {
  assert.match(
    read("app/src/test/java/com/example/packs/HomeViewModelTest.kt"),
    /turbine|test\s*\{/i,
  );
  assert.match(
    read("app/src/test/java/com/example/packs/NoteDaoTest.kt"),
    /RobolectricTestRunner/,
  );
  assert.match(
    read("app/src/androidTest/java/com/example/packs/HomeScreenTest.kt"),
    /createComposeRule/,
  );
});

test("offline proof builds the reference project offline", () => {
  const script = readFileSync(path.join(REPO, "scripts/packs-proof.sh"), "utf8");
  assert.match(script, /examples\/packs-reference/);
  assert.match(script, /:app:assembleDebug/);
  assert.match(script, /:app:testDebugUnitTest/);
  assert.match(script, /:app:assembleDebugAndroidTest/);
  assert.match(script, /--offline/);
  assert.match(script, /GRADLE_USER_HOME/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/packs-reference.test.mjs`
Expected: FAIL with `ENOENT` for `examples/packs-reference/app/build.gradle.kts`.

- [ ] **Step 3: Add the test to `package.json`**

Append `test/packs-reference.test.mjs` after `test/compose-preview.test.mjs`.

- [ ] **Step 4: Commit the failing test**

```bash
git add test/packs-reference.test.mjs package.json
git commit -m "test: pin dependency-pack reference contract (ISSUE-17)"
```

---

### Task 2: Reference project that builds online

**Files:**
- Create: `examples/packs-reference/settings.gradle.kts`
- Create: `examples/packs-reference/build.gradle.kts`
- Create: `examples/packs-reference/gradle.properties`
- Create: `examples/packs-reference/.gitignore`
- Create: `examples/packs-reference/app/build.gradle.kts`
- Create: `examples/packs-reference/app/src/main/AndroidManifest.xml`
- Create: `examples/packs-reference/app/src/main/res/values/strings.xml`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/PacksApp.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/MainActivity.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/Note.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/NoteDao.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/AppDatabase.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/SettingsRepository.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/SyncWorker.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/data/NotesRepository.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/network/NoteApi.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/di/AppModule.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/ui/HomeViewModel.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/ui/HomeScreen.kt`
- Create: `examples/packs-reference/app/src/main/java/com/example/packs/ui/DetailScreen.kt`
- Create: `examples/packs-reference/app/src/test/java/com/example/packs/HomeViewModelTest.kt`
- Create: `examples/packs-reference/app/src/test/java/com/example/packs/NoteDaoTest.kt`
- Create: `examples/packs-reference/app/src/androidTest/java/com/example/packs/HomeScreenTest.kt`
- Create: `examples/packs-reference/README.md`

**Interfaces:**
- Consumes: pins from `manifest/packs.json`.
- Produces: `NotesRepository.notes(): Flow<List<Note>>`, `NotesRepository.save(title: String)`, `HomeViewModel(repository: NotesRepository)`, `HomeScreen(notes, darkMode, onSave, onOpen)`, `DetailScreen(title)`, and `SyncWorker`.

- [ ] **Step 1: Write the Gradle scaffolding**

`settings.gradle.kts` uses `pluginManagement` with `google()`, `mavenCentral()`, `gradlePluginPortal()`, `dependencyResolutionManagement` with `RepositoriesMode.FAIL_ON_PROJECT_REPOS`, `rootProject.name = "packs-reference"`, `include(":app")`.

Root `build.gradle.kts` declares AGP 8.7.2, Kotlin 2.0.21, Compose plugin, kapt, Hilt 2.52 with `apply false`.

`gradle.properties`: `android.useAndroidX=true`, `org.gradle.jvmargs=-Xmx2048m`, `kapt.use.k2=true`.

`app/build.gradle.kts` applies the five plugins, sets `namespace = "com.example.packs"`, `compileSdk = 35`, `minSdk = 26`, `targetSdk = 35`, Java/Kotlin 17, `buildFeatures { compose = true }`, `testOptions { unitTests.isIncludeAndroidResources = true }`, and the dependency list from the contract test plus `androidx.lifecycle:lifecycle-runtime-compose:2.8.7`, `androidx.compose.ui:ui-tooling-preview`, `debugImplementation("androidx.compose.ui:ui-tooling")` and `debugImplementation("androidx.compose.ui:ui-test-manifest")`. Add `testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")`.

- [ ] **Step 2: Write the production sources**

Implement the interfaces listed above. Keep the UI stateless: `HomeScreen` takes `notes`, `darkMode`, `onSave`, `onOpen`; `MainActivity` collects `StateFlow` with `collectAsStateWithLifecycle()` and owns the `NavHost` (`home`, `detail/{title}`). `NoteDao` exposes both `observeAll(): Flow<List<Note>>` and `pagingSource(): PagingSource<Int, Note>`. `DefaultNotesRepository` combines Room, Retrofit (`ResponseBody`), DataStore and a Pager. `SyncWorker` is a plain `CoroutineWorker` returning `Result.success()`. Coil is used through `AsyncImage` in `HomeScreen`.

- [ ] **Step 3: Write the tests**

`HomeViewModelTest` uses `Dispatchers.setMain(StandardTestDispatcher())`, a fake `NotesRepository`, and Turbine to assert the initial empty state and the saved title. `NoteDaoTest` is a Robolectric test with an in-memory `AppDatabase`. `HomeScreenTest` is an instrumented Compose rule test that renders the empty state.

- [ ] **Step 4: Build online once to warm the Hilt plugin and compile**

Run:

```bash
bash -c 'source .toolchain/env.sh && gradle -p examples/packs-reference --no-daemon --console=plain :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest'
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Run the unit tests online**

Run: `bash -c 'source .toolchain/env.sh && gradle -p examples/packs-reference --no-daemon --console=plain :app:testDebugUnitTest'`
Expected: `BUILD SUCCESSFUL`; inspect `app/build/test-results/testDebugUnitTest/*.xml` for `failures="0" errors="0"`.

- [ ] **Step 6: Commit**

```bash
git add examples/packs-reference
git commit -m "feat(examples): add dependency-pack reference project (ISSUE-17)"
```

---

### Task 3: Warm Gradle plugin markers from the pack manifest

**Files:**
- Modify: `manifest/packs.json`
- Modify: `scripts/pack-warm.sh`
- Modify: `scripts/pack-matrix.mjs`
- Modify: `test/packs.test.mjs`
- Modify: `test/packs-reference.test.mjs`

**Interfaces:**
- Produces: optional `plugins: ["group:artifact:version"]` per pack; pack-warm applies each as `id(...) version "..."`; pack-matrix reports `plugins` rows with resolved/missing status.

- [ ] **Step 1: Extend the failing contract test**

Assert `manifest/packs.json` `packs.di.plugins` contains `com.google.dagger.hilt.android:2.52`, and `scripts/pack-warm.sh` contains `plugins` handling. Run it; expect FAIL.

- [ ] **Step 2: Implement plugin warming**

Add `"plugins": ["com.google.dagger.hilt.android:2.52"]` to `di`. In `pack-warm.sh`'s generator, emit a `plugins { ... }` block for each `group:artifact:version`, where the plugin id is the artifact and the version is the third segment. Keep `id("com.android.application") version "8.7.2"` in the same block. In `pack-matrix.mjs`, check plugin markers under `<group>/<artifact>/<version>` and include them in the pack total. The Hilt plugin's own `kapt` requirement must not break the synthetic project; if it does, apply only `com.android.application` plus the Hilt plugin and add `id("org.jetbrains.kotlin.kapt")` only when the Hilt plugin is present.

- [ ] **Step 3: Run the pack tooling tests**

Run: `node --test test/packs.test.mjs test/packs-reference.test.mjs`
Expected: PASS.

- [ ] **Step 4: Re-warm the di pack online and prove offline resolution**

Run: `bash scripts/pack-warm.sh di`
Expected: `[pack-warm] Done.` after the offline resolution check.

- [ ] **Step 5: Commit**

```bash
git add manifest/packs.json scripts/pack-warm.sh scripts/pack-matrix.mjs test/packs.test.mjs test/packs-reference.test.mjs
git commit -m "feat(packs): warm Gradle plugin markers for offline consumers (ISSUE-17)"
```

---

### Task 4: Offline proof script and doctor gate

**Files:**
- Create: `scripts/packs-proof.sh`
- Modify: `scripts/doctor.sh`
- Modify: `docs/offline.md`
- Modify: `BACKLOG.md`
- Modify: `README.md`

**Interfaces:**
- Produces: `scripts/packs-proof.sh` exit 0 only when all three Gradle tasks pass offline; doctor prints `OK   packs-proof: reference project resolves every pack offline` or `MISS` and fails.

- [ ] **Step 1: Write `scripts/packs-proof.sh`**

Copy `examples/packs-reference` to `.toolchain/packs-proof` after `rm -rf`, source `.toolchain/env.sh`, export `GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.toolchain/gradle-home}"`, and run:

```bash
gradle --no-daemon -p "$PROOF" :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest --offline
```

Remove both the source copy's `build/` and `.gradle/` before the build; remove the proof dir on success and on failure. Print a clear message naming `scripts/pack-warm.sh` when it fails.

- [ ] **Step 2: Wire doctor**

After the existing offline-proof check, run `bash "$ROOT/scripts/packs-proof.sh"`; print `OK   packs-proof: reference project resolves every pack offline` or `MISS packs-proof: ... (run scripts/pack-warm.sh online)` and set `fail=1`.

- [ ] **Step 3: Verify the proof on this host**

Run: `bash scripts/packs-proof.sh`
Expected: `BUILD SUCCESSFUL` for the three tasks and exit 0. Record the wall time.

- [ ] **Step 4: Run doctor**

Run: `bash scripts/doctor.sh`
Expected: contains the new OK line.

- [ ] **Step 5: Update docs and backlog**

`docs/offline.md`: document the reference project, the three tasks, and plugin warming. `BACKLOG.md`: ISSUE-17 → shipped with measured time; FR-R1 acceptance → shipped; FR-B1 note that the wrapper question remains separate. `README.md`: add `examples/packs-reference/` to the “What’s included” table and mention it under offline.

- [ ] **Step 6: Full gates**

Run: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `bash scripts/repo-hygiene.sh`, `bash scripts/check-readme.sh`.
Expected: all green; remove `examples/packs-reference/app/build` and `.gradle` before hygiene.

- [ ] **Step 7: Commit**

```bash
git add scripts/packs-proof.sh scripts/doctor.sh docs/offline.md BACKLOG.md README.md
git commit -m "feat(offline): prove every dependency pack with a reference project (ISSUE-17)"
```
