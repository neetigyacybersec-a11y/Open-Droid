#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"
fail=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS_KIND="win" ;;
  Darwin*)              OS_KIND="mac" ;;
  *)                    OS_KIND="linux" ;;
esac
check(){ if command -v "$1" >/dev/null 2>&1; then echo "OK   $1 -> $(command -v "$1")"; else echo "MISS $1"; fail=1; fi; }
# Some Android tools are only available as .bat files on Windows hosts.
present(){ if command -v "$1" >/dev/null 2>&1 || { [ "$OS_KIND" = "win" ] && command -v "$1.bat" >/dev/null 2>&1; }; then return 0; else return 1; fi; }
present_check(){ if present "$1"; then echo "OK   $1"; else echo "MISS $1"; fail=1; fi; }
warn(){ echo "WARN $*"; }
echo "== android-mcp doctor =="
if [ -f "$TOOLCHAIN/env.sh" ]; then source "$TOOLCHAIN/env.sh"; echo "toolchain env: loaded"; else echo "toolchain env: NOT FOUND (run 'make setup')"; fi
for c in node java javac; do check "$c"; done
for c in gradle adb emulator; do present_check "$c"; done
# cmdline-tools (sdkmanager/avdmanager) — .bat on Windows
for c in sdkmanager avdmanager; do present_check "$c"; done
# maestro
if command -v maestro >/dev/null 2>&1 || { [ "$OS_KIND" = "win" ] && present "maestro"; }; then echo "OK   maestro"; else check maestro; fi
# optional
for c in compose-preview android; do
  if present "$c"; then echo "OK   $c (optional)"; else echo "MISS $c (optional)"; fi
done
# dynamic analysis (frida + mitmproxy via .toolchain/python-venv, frida-server binaries)
for c in frida frida-ps mitmdump; do
  if present "$c"; then echo "OK   $c (dynamic)"; else warn "$c missing (optional; dynamic analysis unavailable)"; fi
done
# python3: probe it actually runs (a Windows Store stub passes `command -v`)
if command -v python3 >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; then
  echo "OK   python3 (dynamic)"
else
  warn "python3 missing or not runnable (Windows Store stub?) — dynamic analysis unavailable"
fi
# Decompressed binaries only: a leftover *.xz means the download/decompress step lagged behind.
if find "$TOOLCHAIN/frida" -maxdepth 1 -type f -name 'frida-server-*' ! -name '*.xz' -print -quit 2>/dev/null | grep -q .; then
  echo "OK   frida-server binaries present"
else
  warn "frida-server binaries missing (dynamic analysis unavailable)"
fi
echo "ANDROID_HOME=${ANDROID_HOME:-unset}"
echo "JAVA_HOME=${JAVA_HOME:-unset}"
echo "GRADLE_USER_HOME=${GRADLE_USER_HOME:-unset}"
echo "node=$(node -v 2>/dev/null)  npm=$(npm -v 2>/dev/null)"
[ -f "$ROOT/dist/index.js" ] && echo "MCP build: present" || { echo "MCP build: MISSING (run npm run build)"; fail=1; }
[ -d "$TOOLCHAIN/android-skills/.git" ] && echo "android/skills: cloned" || echo "android/skills: not cloned (optional)"

# KVM / emulator readiness (Linux; other OSes use their own hypervisors)
HOST_ARCH="$(uname -m)"
if [ "$OS_KIND" = "linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
  IMG_ABI="x86_64"
  if [ ! -e /dev/kvm ]; then warn "/dev/kvm not present; x86_64 emulator cannot run (install qemu-kvm + add user to kvm group)"; else
    if [ -w /dev/kvm ]; then echo "OK   KVM writable"; else warn "/dev/kvm exists but not writable for this user (run: sudo gpasswd -a \$USER kvm; re-login)"; fi
  fi
elif [ "$OS_KIND" = "linux" ] && [ "$HOST_ARCH" = "aarch64" ]; then
  IMG_ABI="arm64-v8a"
  echo "OK   arm64 host: use arm64-v8a system images"
elif [ "$OS_KIND" = "win" ]; then
  IMG_ABI="x86_64"
  echo "OK   Windows host: emulator uses Android Emulator Hypervisor Driver (AEHD) or Hyper-V (run under Git Bash/WSL2); no /dev/kvm expected"
else
  IMG_ABI="arm64-v8a"
  echo "OK   macOS host: emulator uses Hypervisor.framework (hvf); no KVM needed"
fi

# AVD ABI match
AVDS="$(emulator -list-avds 2>/dev/null || true)"
if [ -n "$AVDS" ]; then
  echo "AVDs: $(echo "$AVDS" | tr '\n' ' ')"
  for avd in $AVDS; do
    CFG="$HOME/.android/avd/$avd.avd/config.ini"
    [ -f "$CFG" ] && grep -q "abi.type=.*arm" "$CFG" && [ "$HOST_ARCH" != "aarch64" ] && [ "$IMG_ABI" != "arm64-v8a" ] && warn "AVD $avd is arm64 on x86_64 host (will not boot)"
  done
else
  warn "No AVDs found (run: make setup, or avdmanager create avd ...)"
fi

# offline build readiness
if [ -d "$TOOLCHAIN/gradle-home/caches" ]; then echo "OK   gradle cache warmed (offline builds will resolve)"; else warn "Gradle cache not warmed yet; run scripts/warm-cache.sh once online"; fi

# OpenCode registration
if command -v opencode >/dev/null 2>&1; then
  # check the GLOBAL config files directly (project-level registrations must not count)
  if { [ -f "$HOME/.config/opencode/opencode.jsonc" ] && grep -q '"android-mcp"' "$HOME/.config/opencode/opencode.jsonc"; } || { [ -f "$HOME/.config/opencode/opencode.json" ] && grep -q '"android-mcp"' "$HOME/.config/opencode/opencode.json"; }; then echo "OK   opencode: android-mcp registered (global)"; else warn "opencode: android-mcp NOT registered globally (run 'make register')"; fi
  gsk="$(ls -d "$HOME/.config/opencode/skills"/*/SKILL.md 2>/dev/null | wc -l)"
  srcsk="$(ls -d "$ROOT/skills"/*/SKILL.md 2>/dev/null | wc -l)"
  if [ "$gsk" -gt 0 ]; then
    echo "OK   opencode: $gsk global skills present (source has $srcsk)"
    if [ "$gsk" -ne "$srcsk" ]; then warn "opencode: global skill count ($gsk) != source count ($srcsk) — run 'make register' to refresh"; fi
  else
    warn "opencode: no global skills found (run 'make register')"
  fi
else
  warn "opencode CLI not installed; registration skipped"
fi

# If something required is missing, echo the detected PATH so users can see
# why a check missed (PATH-inheritance/Git-Bash-munging issues).
if [ "$fail" -ne 0 ]; then
  echo "-- PATH used by this invocation:"
  echo "   $PATH"
fi
exit_code="$fail"
exit "$exit_code"