# Offline / "no additional downloads" contract

After `make setup` completes (or after `docker pull`), the repository is fully
self-contained:

- All binaries resolve under `.toolchain/` (or are baked into the image).
- `make doctor` verifies every required tool is present.
- Gradle builds use the vendored Gradle on `PATH` (no wrapper download).
- Maestro, emulator, and SDK tools are local.

The only network access is the one-time bootstrap (`make setup`) or the image pull.

## Dependency packs (FR-R1)

The starter only needs the `compose` pack. Real products also need navigation,
Room/DataStore/WorkManager/Paging, Retrofit/OkHttp/Coil, Hilt and the test stack.
Those are declared as pinned coordinates in `manifest/packs.json`, together with
**plugin markers**: a Gradle plugin is resolved separately from its library, so
the cache must hold e.g. `com.google.dagger.hilt.android.gradle.plugin/2.52` as
well as `hilt-android`.

```bash
# Warm every pack declared in the manifest (online).
bash scripts/pack-warm.sh

# Or a subset; warm-cache passes it through.
make warm-cache PACKS="app,data,net,di,test"
```

`pack-warm.sh` generates a throwaway AGP project that applies the pack libraries
and plugin markers, resolves it online, then re-resolves the same project with
`--offline`. `scripts/pack-matrix.mjs --summary` (also printed by `make doctor`)
reports per-pack cached/missing artifacts; the matrix is informational.

The cache is only proven by a real consumer. `examples/packs-reference` uses
every pack in code (Hilt, Room + Paging, DataStore, WorkManager, Retrofit,
OkHttp, Coil, Navigation, Compose, Turbine/Robolectric). `scripts/packs-proof.sh`
copies it to `.toolchain/packs-proof`, strips build outputs, and runs:

```bash
:app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest --offline
```

`make doctor` runs that proof as a hard check. The proof uses the vendored
`GRADLE_USER_HOME` (isolated from the maintainer's `~/.gradle`); the instrumented
test is compiled, not executed, because no device is required for the proof.
