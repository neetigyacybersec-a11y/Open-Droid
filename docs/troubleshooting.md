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

## OpenCode registration
| Symptom | Root cause | Fix |
|---|---|---|
| `opencode mcp list` doesn't show android-mcp | Registration only happened in project config (`.opencode/opencode.jsonc`), which is only read when OpenCode starts inside the repo | `make setup`/`make register` adds it **globally** via `opencode mcp add android-mcp --global`; works from any directory |
| Skills don't appear in the `skill` tool | Skills lived only in the repo; discovery depends on CWD | `make register` copies all skills into `~/.config/opencode/skills/` (always loaded globally); re-run to refresh |

## Emulator alternative on hosts without KVM
Use a CI runner with KVM, or run the Android app on a physical device
(`adb devices` after enabling USB debugging).
## Dynamic analysis
| Symptom | Root cause | Fix |
|---|---|---|
| `device image 'release-keys' cannot adb root` | `default` (non-rootable) system image installed | Re-run `make setup` on a host with KVM; ensure `google_apis` image selected |
| `frida-server ... missing` / ABI mismatch | Server ABI ≠ AVD ABI | `make setup` vendors both arches; `mapAbiToAsset` errors name the offending ABI |
| `frida CLI not found` | Venv not created | `make setup` (requires python3 + python3-venv) |
| `net_capture busy` | A capture is already running | `net_capture stop`, then retry |
| Proxy stuck after capture | `stop` not called / server exited | `adb shell settings put global http_proxy :0` |
| CA not installed | System image read-only | Trust the user cert manually, or use a rootable image |
| python3 missing | Not installed | `sudo apt install -y python3 python3-venv` |
