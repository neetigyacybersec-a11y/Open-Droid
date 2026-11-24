#!/usr/bin/env bash
# ISSUE-141: prove the image itself carries every non-device dependency used by
# registered MCP handlers. Runs at build time and again in CI against the
# built image; no host tool is consulted.
set -euo pipefail
fail() { echo "docker smoke FAIL: $*" >&2; exit 1; }

[ -f /app/versions.env ] || fail "versions.env missing from image"
[ -f /app/frida-scripts/hook-method.js ] || fail "frida-scripts/hook-method.js missing"
[ -x /app/.toolchain/python-venv/bin/frida ] || fail "vendored frida CLI missing"
[ -x /app/.toolchain/python-venv/bin/frida-ps ] || fail "vendored frida-ps missing"
[ -x /app/.toolchain/python-venv/bin/mitmdump ] || fail "vendored mitmdump missing"

. /app/versions.env
echo "toolchain pins: gradle=${GRADLE_VERSION} jadx=${JADX_VERSION} apktool=${APKTOOL_VERSION} frida=${FRIDA_VERSION} mitmproxy=${MITMPROXY_VERSION}"

for tool in gradle aapt2 jadx apktool compose-preview android frida frida-ps mitmdump maestro; do
  command -v "$tool" >/dev/null 2>&1 || fail "MISSING executable: $tool"
done

for abi in x86_64 arm64; do
  server="/app/.toolchain/frida/frida-server-${FRIDA_VERSION}-android-${abi}"
  [ -x "$server" ] || fail "MISSING frida-server asset: $server"
done
[ -x /app/.toolchain/gradle/bin/gradle ] || fail "bundled Gradle launcher missing"
# ISSUE-144: the image keeps the provenance manifest but not the TypeScript
# sources that produced it, so build-state treats dist/ as authoritative.
[ -f /app/dist/build-manifest.json ] || fail "build manifest missing from image"
[ ! -d /app/src ] || fail "production image must not ship the src/ tree"

gradle --version >/dev/null
echo "capabilities OK; running MCP handler smoke"
node /app/scripts/docker-mcp-smoke.mjs
