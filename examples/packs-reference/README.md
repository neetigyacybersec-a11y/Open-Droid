# Packs reference (FR-R1 / ISSUE-17)

A deliberately small app that consumes **every** dependency pack declared in
`manifest/packs.json`: `compose`, `app`, `data`, `net`, `di` and `test`.

It exists to prove the offline cache with real code, not by checking that
directories exist. The acceptance command is in `scripts/packs-proof.sh`; it
runs with `GRADLE_USER_HOME=.toolchain/gradle-home` and `--offline`:

```bash
:app:assembleDebug
:app:testDebugUnitTest
:app:assembleDebugAndroidTest
```

## What each pack proves

| Pack | Used by |
|---|---|
| `compose` | `HomeScreen` (Material 3, `LazyColumn`, preview tooling) |
| `app` | `MainActivity` `NavHost`, `HomeViewModel` `StateFlow` |
| `data` | Room `NoteDao`/`AppDatabase`, DataStore `SettingsRepository`, `SyncWorker`, `Pager` |
| `net` | Retrofit `NoteApi`, OkHttp logging client, kotlinx-serialization `Json`, Coil `AsyncImage` |
| `di` | Hilt `@HiltAndroidApp`, `@AndroidEntryPoint`, `@HiltViewModel`, modules |
| `test` | Turbine ViewModel test, Robolectric Room test, instrumented Compose test |

## Running it

```bash
# Online once: warms the Hilt plugin marker and compiles the app.
bash -c 'source .toolchain/env.sh && gradle -p examples/packs-reference --no-daemon \
  :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest'

# Offline proof (also run by make doctor).
bash scripts/packs-proof.sh
```

This is a test fixture, not a starter template. `templates/compose-starter` is
the production starter; FR-R2 is the multi-module production template.
