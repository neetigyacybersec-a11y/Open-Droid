#!/usr/bin/env bash
set -e

# Start adb server
adb start-server >/dev/null 2>&1 || true

# Boot an emulator in the background if an AVD exists and no device is connected
if command -v emulator >/dev/null 2>&1; then
  AVD="$(emulator -list-avds 2>/dev/null | head -n1)"
  if [ -n "$AVD" ] && ! adb devices | grep -q "device$"; then
    emulator -avd "$AVD" -no-window -no-audio -gpu swiftshader_indirect >/tmp/emulator.log 2>&1 &
    # give it a moment
    sleep 5
  fi
fi

exec node /app/dist/index.js
