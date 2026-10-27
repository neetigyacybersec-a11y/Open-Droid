# Troubleshooting (new-host install checklist)

Errors observed when installing on a fresh host and how this repo prevents them:

## Build phase
| Symptom | Root cause | Fix (now built in) |
|---|---|---|
| `Could not resolve com.android.tools.build:gradle:... No cached version available for offline mode.` | `--offline` used before any online build populated the Gradle cache | `make setup` now warms the cache once (see `scripts/warm-cache.sh`); then `--offline` works |
| `AGP X tested up to compileSdk 34, but project uses 35` | AGP version too old for target SDK | Template uses AGP 8.7.2 which supports `compileSdk 35` |
| `package="..." in AndroidManifest.xml is no longer supported` | Legacy manifest attribute | Template sets `namespace` in `build.gradle.kts` only; no `package=` attr |
| `resource mipmap/ic_launcher not found` | Manifest referenced missing icons | Template ships adaptive launcher icons (`mipmap-anydpi-v26`) |
| `source/target value 8 is obsolete` | Old Java target | Template uses Java 17 |

## Toolchain / environment
| Symptom | Root cause | Fix (now built in) |
|---|---|---|
| `JAVA_HOME is not set...` from `sdkmanager`/`avdmanager` | Env not exported | `setup.sh` exports `JAVA_HOME`/`PATH` before running them; `env.sh` sets it for shells |
| `SDK XML version 4 ... only understands up to 3` | cmdline-tools too old | `versions.env` pins `CMDLINE_TOOLS_VERSION=13114758` |

## Emulator
| Symptom | Root cause | Fix |
|---|---|---|
| `This user doesn't have permissions to use KVM (/dev/kvm)` | User not in `kvm` group | `sudo apt install -y qemu-kvm && sudo gpasswd -a $USER kvm` then log out/in; `make doctor` checks this |
| `x86_64 emulation currently requires hardware acceleration!` | No KVM at all | Install KVM (above) or use an ARM64 host with arm64 images |
| `Avd's CPU Architecture 'arm64' is not supported by QEMU2 on x86_64 host` | AVD ABI mismatched host CPU | `setup.sh` selects the system image ABI from `uname -m`; `make doctor` flags mismatched AVDs |

## Optional CLIs (best-effort installs during setup)
- `compose-preview` (compose-ai-tools) — enables Compose preview rendering.
- `android` CLI — enables `android skills list/search`.
Both are installed by `make setup` when possible and are safe to install later.

## Emulator alternative on hosts without KVM
Use a CI runner with KVM, or run the Android app on a physical device
(`adb devices` after enabling USB debugging).
EOF
echo done