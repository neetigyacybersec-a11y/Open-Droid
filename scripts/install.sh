#!/usr/bin/env bash
# ISSUE-148: POSIX native installer entry point. Downloads a pinned Node if the
# host has none, then runs the same Node installer used on Windows.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/versions.env"
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  MAJOR="$(node --version | sed 's/^v//; s/\..*//')"
  [ "$MAJOR" -ge "$NODE_MAJOR" ] || NODE_BIN=""
fi
if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  DEST="$ROOT/.toolchain/node"
  TAR="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
  mkdir -p "$DEST"
  if [ ! -x "$DEST/node-v${NODE_VERSION}-linux-${ARCH}/bin/node" ]; then
    (cd "$DEST" && wget -q "https://nodejs.org/dist/v${NODE_VERSION}/${TAR}" \
      && wget -q "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
      && grep "$TAR" SHASUMS256.txt | sha256sum -c - \
      && tar -xf "$TAR" \
      && rm -f "$TAR" SHASUMS256.txt)
  fi
  NODE_BIN="$DEST/node-v${NODE_VERSION}-linux-${ARCH}/bin/node"
fi
exec "$NODE_BIN" "$ROOT/scripts/install.mjs" "$@"
