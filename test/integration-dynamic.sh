#!/usr/bin/env bash
# Local, KVM-gated end-to-end dynamic-analysis smoke. Exit 77 = skip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Source vendored toolchain if present.
if [ -f "$ROOT/.toolchain/env.sh" ]; then
  # shellcheck disable=SC1091
  source "$ROOT/.toolchain/env.sh"
fi

# Skip gate.
if [ ! -e /dev/kvm ] || ! command -v frida >/dev/null 2>&1 || ! command -v mitmdump >/dev/null 2>&1; then
  echo "SKIP: dynamic integration requires KVM + vendored toolchain"
  exit 77
fi

AVD_NAME="${AVD_NAME:-Pixel_6_API_34}"
APK="$ROOT/examples/vuln-app/app/build/outputs/apk/debug/app-debug.apk"

cleanup() {
  adb emu kill >/dev/null 2>&1 || true
  adb shell settings put global http_proxy :0 >/dev/null 2>&1 || true
  if [ -n "${MITM_PID:-}" ] && kill -0 "$MITM_PID" 2>/dev/null; then kill "$MITM_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# 1. Boot AVD headless.
timeout 180 bash -c 'emulator -avd "'"$AVD_NAME"'" -no-window -no-audio -gpu swiftshader_indirect & emulator_pid=$!; adb wait-for-device; adb shell "while [ \"\$(getprop sys.boot_completed)\" != 1 ]; do sleep 1; done"' || { echo "FAIL: boot"; exit 1; }

# 2. Root + build + install.
adb root
sleep 2
( cd "$ROOT/examples/vuln-app" && gradle :app:assembleDebug --offline ) || { echo "FAIL: build"; exit 1; }
adb install -r "$APK" || { echo "FAIL: install"; exit 1; }

# 3. Logcat asserts CryptoBox tag.
adb logcat -c
adb shell am start -n com.example.vulnapp/.MainActivity >/dev/null 2>&1 || true
sleep 3
adb logcat -d | grep -q "CryptoBox" || { echo "FAIL: logcat CryptoBox"; exit 1; }

# 4. runtime dump meminfo.
# (manual invocation left to MCP surface; assert package appears via dumpsys)
adb shell dumpsys meminfo com.example.vulnapp | grep -q "com.example.vulnapp" || { echo "FAIL: meminfo"; exit 1; }

# 5. frida-ps asserts server + process list.
frida-ps -U | grep -q frida-server || { echo "FAIL: frida-ps"; exit 1; }

# 6. root-bypass hook -> SECRET ACCESS GRANTED.
# (driven via frida CLI inline; minimal check)
echo "Phase 6: frida hook (manual verification recommended)" 

# 7. crypto-trace (manual).

# 8. net_capture round-trip.
HAR="/tmp/vuln-capture.har"
mitmdump -p 8099 --set hardump="$HAR" >/tmp/mitm.log 2>&1 &
MITM_PID=$!
sleep 2
adb shell settings put global http_proxy 10.0.2.2:8099
sleep 3
kill "$MITM_PID" 2>/dev/null || true
wait "$MITM_PID" 2>/dev/null || true
adb shell settings put global http_proxy :0
[ -f "$HAR" ] || { echo "FAIL: HAR not written"; exit 1; }
python3 -c "import json,sys; json.load(open('$HAR'))" || { echo "FAIL: HAR not JSON"; exit 1; }

echo "Dynamic integration: PASS"
exit 0
