# Offline / "no additional downloads" contract

After `make setup` completes (or after `docker pull`), the repository is fully
self-contained:

- All binaries resolve under `.toolchain/` (or are baked into the image).
- `make doctor` verifies every required tool is present.
- Gradle builds use the vendored Gradle on `PATH` (no wrapper download).
- Maestro, emulator, and SDK tools are local.

The only network access is the one-time bootstrap (`make setup`) or the image pull.
