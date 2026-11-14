# Troubleshooting (new-host install checklist)

## No-root / no-sudo installs

The core install needs **no root**. Everything goes into `./.toolchain/` and
`~/.config/opencode/`. Only these two things may require elevated privileges,
and both are optional:

- **`/dev/kvm` not writable** (x86_64 emulator): ask your admin to add you to
  the `kvm` group, or use an ARM64 host / a physical device.
- **`python3-venv` missing**: dynamic analysis is skipped; core build and tests
  still pass. Install python3-venv via your package manager if you have sudo,
  otherwise use a user-level Python (pyenv/conda) or skip dynamic analysis.

`make doctor` reports each optional item as a warning, not a failure, so a
no-root host still gets a usable MCP server.

Errors observed when installing on a fresh host and how this repo prevents them:

## Build phase
| Symptom | Root cause | Fix (now built in) |
|---|---|---|
| `Could not resolve com.android.tools.build:gradle:... No cached version available for offline mode.` | `--offline` used before any online build populated the Gradle cache | `make setup` now warms the cache once (see `scripts/warm-cache.sh`); then `--offline` works |
| `AGP X tested up to compileSdk 34, but project uses 35` | AGP version too old for target SDK | Template uses AGP 8.7.2 which supports `compileSdk 35` |
| `package="..." in AndroidManifest.xml is no longer supported` | Legacy manifest attribute | Template sets `namespace` in `build.gradle.kts` only; no `package=` attr |
| `resource mipmap/ic_launcher not found` | Manifest referenced missing icons | Template ships adaptive launcher icons (`mipmap-anydpi-v26`) |
| `source/target value 8 is obsolete` | Old Java target | Template uses Java 17 |
| `JDK not found` / download fails | No system JDK and no network to Adoptium | Install Temurin JDK 21 manually (https://adoptium.net) or ensure network access; `make setup` auto-downloads when possible |

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

## Skill discovery / visibility
| Symptom | Root cause | Fix |
|---|---|---|
| Only some skills show up (e.g. only UI skills) | Global skills dir is stale or partially populated; `make register` never ran or failed halfway | Run `make register` (refreshes all skills) and `make doctor` (compares global vs source counts). Also ensure OpenCode is started inside the repo OR skills are installed globally. |
| A skill was removed but still appears | Old register.sh didn't prune; stale copy remains | Update to latest, run `make register` (manifest-based prune removes repo-dropped skills only). |

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
| Emulator window cropped on a high-DPI display | Tall AVD (e.g. 1080x2424) at 125% scaling needs more host pixels than the display height | Boot with `emulator_boot` `scale` (e.g. `0.5`) or `windowSize` (`900x600`); run `node scripts/avd-geometry.mjs --suggest`; last resort is `templates/avd/high-dpi-small-host.config.ini` |
| `device image 'release-keys' cannot adb root` | `default` (non-rootable) system image installed | Re-run `make setup` on a host with KVM; ensure `google_apis` image selected |
| `frida-server ... missing` / ABI mismatch | Server ABI ≠ AVD ABI | `make setup` vendors both arches; `mapAbiToAsset` errors name the offending ABI |
| `frida CLI not found` | Venv not created | `make setup` (requires python3 + python3-venv) |
| `net_capture busy` | A capture is already running | `net_capture stop`, then retry |
| Proxy stuck after capture | `stop` not called / server exited | Call `net_capture stop`; it restores the persisted serial and original proxy. If that reports `recovery-required`, run the printed `adb -s <serial> ...` command and remove `$XDG_STATE_HOME/android-mcp/net-capture.json` |
| `net_capture stop` reports a different device | The session is bound to the serial selected at start | Omit `deviceId` or pass the serial printed in the error; no device was changed |
| CA not installed | System image read-only | Use a rootable image; on API 34+ pushing to the system store is often blocked, so plan for an APEX/Magisk CA overlay or an unpinning hook |
| HTTPS bodies missing from HAR | API 34+ ignores runtime CA additions, and `targetSdk >= 24` apps do not trust user CAs by default | Do not rely on a user cert; use an APEX/Magisk system-CA module or `frida-scripts/ssl-unpin.js` |
| `could not hash mitmproxy CA with openssl` | `openssl` not on `PATH` | `sudo apt install -y openssl` |
| python3 missing | Not installed | `sudo apt install -y python3 python3-venv` |

## Docker route cannot run the emulator

The image ships AVD `Pixel_9_API_35`, the emulator binary and the system image, but
Docker Desktop on Windows/macOS does not expose `/dev/kvm`, so the container cannot
accelerate (or, practically, boot) an emulator:

- `ls /dev/kvm` in the container → `No such file or directory`
- `emulator -accel-check` → `KVM requires a CPU that supports vmx or svm` (exit 3)
- Software rendering (`-accel off`, swiftshader) does boot and `adb` lists
  `emulator-5554`, but a first boot takes ~13 minutes (TCG + first-boot `dex2oat`),
  and `--rm` discards the AVD state so every run pays that cost again.

**Use one of the working alternatives instead:**

- **Physical device:** `adb_wifi { action: "connect", host: "<phone-ip>" }`
- **Host/WSL2 emulator, bridged:** run the container with
  `-e ADB_SERVER_SOCKET=tcp:host.docker.internal:5037`; the MCP server's
  `adb_devices` then talks to the remote adb server on the host.

## Windows / WSL2 prerequisites for `/dev/kvm`

The docs recommend WSL2 for emulator work on Windows, but the Windows-side
prerequisites are non-obvious. Verify them **before** committing to that route:

```bash
ls -l /dev/kvm
dmesg | grep -i -E 'kvm|nested'
grep -m1 -oE 'svm|vmx' /proc/cpuinfo
```

Requirements and gotchas:

- WSL 3.0+ (kernel 6.x) — `wsl --update`. Older WSL (2.4.x / kernel 5.15) ships
  no `kvm*.ko` modules at all, so `/dev/kvm` never appears.
- Windows features enabled: **Virtual Machine Platform** and **Windows Hypervisor
  Platform** (both `InstallState = 1`). HypervisorPlatform alone is not enough.
- **Memory Integrity (HVCI) must be off** (and the machine rebooted) — otherwise
  `Hyper-V: Nested features: 0x0` and `modprobe kvm_amd` fails with
  `SVM not supported by CPU`.
- The CPU must actually expose virtualization to the guest: `svm` (AMD) or `vmx`
  (Intel) must show up in `/proc/cpuinfo`. Some boards (e.g. Gigabyte B450M K
  with a Ryzen 5 4600G) report `VirtualizationFirmwareEnabled=True` on the host
  yet never pass `svm` into the WSL guest, so `/dev/kvm` stays absent even with
  everything else correct. There is no workaround on such hardware — use a
  physical device or the Docker route's ADB bridge instead.
- `wsl --shutdown` also kills Docker Desktop's `docker-desktop` distro, which takes
  a containerised MCP server offline with it. Plan restarts accordingly.

## Git clone
| Symptom | Root cause | Fix |
|---|---|---|
| `git@github.com: Permission denied (publickey)` | No SSH key configured for GitHub | Use the HTTPS URL instead: `git clone https://github.com/neetigyacybersec-a11y/Open-Droid.git`. Or set up an SSH key: https://docs.github.com/en/authentication/connecting-to-github-with-ssh |

## Windows-specific notes (Git Bash/MSYS)
| Symptom | Root cause | Fix |
|---|---|---|
| `make: command not found` | `make` is not bundled with Windows | Run the underlying scripts directly: `bash scripts/setup.sh`, `bash scripts/doctor.sh`, `bash scripts/new-app.sh my-app` (Git Bash). |
| `python3` seems installed (in PATH) but `python3 -c "import sys"` fails / prints a Store hint | Microsoft Store `python3` alias stub | Disable the Store alias (Settings → App execution aliases) or install real Python from python.org; `setup.sh`/`doctor.sh` probe executable-ness rather than only `command -v`. |
| `gradle`/`sdkmanager` not found despite the toolchain being vendored | Windows binaries are `.bat` files, not `.exe` | Invoke `gradle.bat`, `sdkmanager.bat`, `avdmanager.bat` explicitly (doctor checks both names). |
| The Windows Store stub counts as "installed" in scripts | Old scripts only used `command -v` | fixed: executable-ness probe. |
| `npm` blocked in PowerShell | Execution policy blocks `npm.ps1` | Use `npm.cmd`, or run inside Git Bash. |

## Docker: engine not running
`docker build` fails with `...pipe/dockerDesktopLinuxEngine: The system cannot find the file specified` when Docker Desktop is not started. Launch Docker Desktop and confirm `docker info` reports both Client/Server before retrying. The first build is multi-stage and downloads several GB (JDK, Android SDK, Node) — expect a long first build; the "zero downloads" quick-start means zero host toolchain, not zero bytes.
