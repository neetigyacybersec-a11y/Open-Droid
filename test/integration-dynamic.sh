#!/usr/bin/env bash
# Local, KVM-gated end-to-end dynamic-analysis smoke. Exit 77 = skip.
#
# Scope: boot -> build/install -> provision frida-server -> launch/observe ->
# dumpsys -> mitmproxy HAR round-trip. Interactive hook phases (root bypass,
# crypto trace) are intentionally NOT automated here; they need UI taps or a
# target process and are documented as manual steps. See docs/dynamic-analysis.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Source vendored toolchain if present.
if [ -f "$ROOT/.toolchain/env.sh" ]; then
  # shellcheck disable=SC1091
  source "$ROOT/.toolchain/env.sh"
fi

# Skip gate: anything missing here is an environment limitation, not a failure.
if [ ! -e /dev/kvm ] || ! command -v adb >/dev/null 2>&1 \
  || ! command -v frida >/dev/null 2>&1 || ! command -v frida-ps >/dev/null 2>&1 \
  || ! command -v mitmdump >/dev/null 2>&1; then
  echo "SKIP: dynamic integration requires KVM + vendored toolchain"
  exit 77
fi

AVD_NAME="${AVD_NAME:-Pixel_6_API_34}"
APK="$ROOT/examples/vuln-app/app/build/outputs/apk/debug/app-debug.apk"
FRIDA_DIR="$ROOT/.toolchain/frida"
FRIDA_VERSION="$(sed -n 's/^FRIDA_VERSION[[:space:]]*=[[:space:]]*//p' "$ROOT/versions.env" | head -1)"
SERVER_PATH="/data/local/tmp/frida-server"

cleanup() {
  adb shell settings put global http_proxy :0 >/dev/null 2>&1 || true
  if [ -n "${MITM_PID:-}" ] && kill -0 "$MITM_PID" 2>/dev/null; then kill "$MITM_PID" 2>/dev/null || true; fi
  adb emu kill >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Boot AVD headless.
timeout 180 bash -c 'emulator -avd "'"$AVD_NAME"'" -no-window -no-audio -gpu swiftshader_indirect & adb wait-for-device; adb shell "while [ \"\$(getprop sys.boot_completed)\" != 1 ]; do sleep 1; done"' || { echo "FAIL: boot"; exit 1; }

# 2. Root + build + install. No --offline: a fresh checkout still needs to
#    resolve dependencies into the Gradle cache once (setup warms it, but the
#    example app's own artifacts may not be cached yet).
adb root
sleep 2
( cd "$ROOT/examples/vuln-app" && gradle :app:assembleDebug --no-daemon ) || { echo "FAIL: build"; exit 1; }
adb install -r "$APK" || { echo "FAIL: install"; exit 1; }

# 3. Provision frida-server (ensureServer-equivalent: ABI-matched push + start).
ABI="$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
case "$ABI" in
  x86_64) ASSET="x86_64" ;;
  arm64-v8a) ASSET="arm64" ;;
  *) echo "FAIL: unsupported device ABI '$ABI'"; exit 1 ;;
esac
SERVER="$FRIDA_DIR/frida-server-${FRIDA_VERSION}-android-${ASSET}"
[ -f "$SERVER" ] || { echo "FAIL: missing $SERVER — run 'make setup'"; exit 1; }
adb push "$SERVER" "$SERVER_PATH" >/dev/null || { echo "FAIL: frida-server push"; exit 1; }
adb shell chmod 755 "$SERVER_PATH" || { echo "FAIL: frida-server chmod"; exit 1; }
adb shell "pkill -f frida-server || true" >/dev/null 2>&1 || true
adb shell "nohup $SERVER_PATH >/dev/null 2>&1 &" >/dev/null 2>&1 || true
sleep 2
frida-ps -U >/dev/null || { echo "FAIL: frida-server not reachable via frida-ps -U"; exit 1; }

# 4. Launch the target (its onCreate seeds CryptoBox + ApiService).
adb logcat -c
adb shell am start -n com.example.vulnapp/.MainActivity >/dev/null 2>&1 || true
sleep 3
# Informational only: the CryptoBox tag depends on UI timing, so a miss is a
# note, not a failure. Assert on the process via dumpsys instead.
if adb logcat -d | grep -q "CryptoBox"; then
  echo "Phase 4: CryptoBox tag observed in logcat"
else
  echo "Phase 4: NOTE CryptoBox tag not observed yet (app may still be starting)"
fi

# 5. Runtime dump: the package must be alive.
adb shell dumpsys meminfo com.example.vulnapp | grep -q "com.example.vulnapp" || { echo "FAIL: meminfo"; exit 1; }

# 6-7. Interactive hooks are manual by design:
#   - root bypass: open SecretActivity from the app button while running
#     frida-scripts/root-bypass.js; expect "SECRET ACCESS GRANTED".
#   - crypto trace: run frida-scripts/crypto-trace.js and trigger encrypt().
# TODO: automate once a deterministic trigger (broadcast/intent) exists.
echo "Phase 6-7: root-bypass + crypto-trace are manual (see docs/dynamic-analysis.md)"

# 8. net_capture round-trip (HTTP proxy wiring + HAR flush).
HAR="/tmp/vuln-capture.har"
rm -f "$HAR"
mitmdump -p 8099 --set hardump="$HAR" >/tmp/mitm.log 2>&1 &
MITM_PID=$!
sleep 2
adb shell settings put global http_proxy 10.0.2.2:8099
sleep 3
kill "$MITM_PID" 2>/dev/null || true
wait "$MITM_PID" 2>/dev/null || true
MITM_PID=""
adb shell settings put global http_proxy :0
[ -f "$HAR" ] || { echo "FAIL: HAR not written"; exit 1; }
python3 -c "import json,sys; json.load(open('$HAR'))" || { echo "FAIL: HAR not JSON"; exit 1; }

echo "Dynamic integration: PASS"
exit 0
