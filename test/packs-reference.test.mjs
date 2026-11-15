// FR-R1 / ISSUE-17: a warmed cache is only proven by a real consumer.
// The reference project must exercise every declared pack, not just declare it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PROJECT = path.join(REPO, "examples/packs-reference");
const read = (p) => readFileSync(path.join(PROJECT, p), "utf8");

test("packs reference project wires every dependency pack", () => {
  const appGradle = read("app/build.gradle.kts");
  for (const coordinate of [
    "androidx.navigation:navigation-compose:2.8.5",
    "androidx.room:room-runtime:2.6.1",
    "androidx.room:room-paging:2.6.1",
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

  const packs = JSON.parse(readFileSync(path.join(REPO, "manifest/packs.json"), "utf8"));
  assert.deepEqual(
    packs.packs.di.plugins,
    ["com.google.dagger.hilt.android:2.52"],
    "the di pack must declare the Hilt plugin marker, not just libraries",
  );
});

test("packs reference project exercises every pack at compile or runtime", () => {
  const files = {
    app: read("app/src/main/java/com/example/packs/PacksApp.kt"),
    activity: read("app/src/main/java/com/example/packs/MainActivity.kt"),
    dao: read("app/src/main/java/com/example/packs/data/NoteDao.kt"),
    db: read("app/src/main/java/com/example/packs/data/AppDatabase.kt"),
    store: read("app/src/main/java/com/example/packs/data/SettingsRepository.kt"),
    worker: read("app/src/main/java/com/example/packs/data/SyncWorker.kt"),
    paging: read("app/src/main/java/com/example/packs/data/NotesRepository.kt"),
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
  assert.match(read("app/src/test/java/com/example/packs/NoteDaoTest.kt"), /RobolectricTestRunner/);
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

test("doctor treats a failing pack proof as a hard failure", () => {
  const doctor = readFileSync(path.join(REPO, "scripts/doctor.sh"), "utf8");
  const at = doctor.indexOf("scripts/packs-proof.sh");
  assert.ok(at > -1, "doctor must run the packs proof, not just the matrix");
  const block = doctor.slice(at, at + 400);
  assert.match(block, /fail=1/, "a failed pack proof must fail doctor");
});
