#!/usr/bin/env bash
# ISSUE-168: the image is a toolchain, not the MCP runtime. Prove every
# non-device dependency used by host-side handlers is present, and prove the
# MCP server itself is absent. Runs at build time and again in CI against the
# built image; no host tool is consulted.
set -euo pipefail
fail() { echo "docker smoke FAIL: $*" >&2; exit 1; }

[ -f /app/versions.env ] || fail "versions.env missing from image"
[ -f /app/frida-scripts/hook-method.js ] || fail "frida-scripts/hook-method.js missing"
[ -x /app/.toolchain/python-venv/bin/frida ] || fail "vendored frida CLI missing"
[ -x /app/.toolchain/python-venv/bin/frida-ps ] || fail "vendored frida-ps missing"
[ -x /app/.toolchain/python-venv/bin/mitmdump ] || fail "vendored mitmdump missing"

# ISSUE-168: a toolchain image that ships the MCP application can drift into
# acting as the server again. Fail the build instead.
for forbidden in /app/src /app/dist /app/node_modules /app/package.json \
                 /app/scripts/run-mcp.sh /app/scripts/docker-mcp-smoke.mjs /app/dist/index.js; do
  [ ! -e "$forbidden" ] || fail "toolchain image must not ship the MCP server: $forbidden"
done

. /app/versions.env
echo "toolchain pins: gradle=${GRADLE_VERSION} jadx=${JADX_VERSION} apktool=${APKTOOL_VERSION} frida=${FRIDA_VERSION} mitmproxy=${MITMPROXY_VERSION}"

for tool in java gradle aapt2 jadx apktool compose-preview android frida frida-ps mitmdump maestro; do
  command -v "$tool" >/dev/null 2>&1 || fail "MISSING executable: $tool"
done

for abi in x86_64 arm64; do
  server="/app/.toolchain/frida/frida-server-${FRIDA_VERSION}-android-${abi}"
  [ -x "$server" ] || fail "MISSING frida-server asset: $server"
done
[ -x /app/.toolchain/gradle/bin/gradle ] || fail "bundled Gradle launcher missing"

gradle --version >/dev/null
java -version >/dev/null
echo "toolchain capabilities OK; image contains no MCP server"
