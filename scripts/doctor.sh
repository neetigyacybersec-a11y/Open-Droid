#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"
fail=0
check(){ if command -v "$1" >/dev/null 2>&1; then echo "OK   $1 -> $(command -v "$1")"; else echo "MISS $1"; fail=1; fi; }
warn(){ echo "WARN $*"; }
echo "== android-mcp doctor =="
if [ -f "$TOOLCHAIN/env.sh" ]; then source "$TOOLCHAIN/env.sh"; echo "toolchain env: loaded"; else echo "toolchain env: NOT FOUND (run 'make setup')"; fi
for c in node java javac gradle adb emulator sdkmanager avdmanager maestro; do check "$c"; done
# optional
for c in compose-preview android; do
  if command -v "$c" >/dev/null 2>&1; then echo "OK   $c (optional)"; else echo "MISS $c (optional)"; fi
done
# dynamic analysis (frida + mitmproxy via .toolchain/python-venv, frida-server binaries)
for c in frida frida-ps mitmdump python3; do
  if command -v "$c" >/dev/null 2>&1; then echo "OK   $c (dynamic)"; else warn "$c missing (optional; dynamic analysis unavailable). Install python3/python3-venv if possible"; fi
done
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

# KVM / emulator readiness
HOST_ARCH="$(uname -m)"
if [ "$HOST_ARCH" = "x86_64" ]; then
  if [ ! -e /dev/kvm ]; then warn "/dev/kvm not present; x86_64 emulator cannot run (install qemu-kvm + add user to kvm group)"; else
    if [ -w /dev/kvm ]; then echo "OK   KVM writable"; else warn "/dev/kvm exists but not writable for this user (run: sudo gpasswd -a \$USER kvm; re-login)"; fi
  fi
elif [ "$HOST_ARCH" = "aarch64" ]; then
  echo "OK   arm64 host: use arm64-v8a system images"
fi

# AVD ABI match
AVDS="$(emulator -list-avds 2>/dev/null || true)"
if [ -n "$AVDS" ]; then
  echo "AVDs: $(echo "$AVDS" | tr '\n' ' ')"
  for avd in $AVDS; do
    CFG="$HOME/.android/avd/$avd.avd/config.ini"
    [ -f "$CFG" ] && grep -q "abi.type=.*arm" "$CFG" && [ "$HOST_ARCH" != "aarch64" ] && warn "AVD $avd is arm64 on x86_64 host (will not boot)"
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
  if [ "$gsk" -gt 0 ]; then echo "OK   opencode: $gsk global skills present"; else warn "opencode: no global skills found (run 'make register')"; fi
else
  warn "opencode CLI not installed; registration skipped"
fi

exit $fail