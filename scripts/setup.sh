#!/usr/bin/env bash
# One-command bootstrap: downloads the entire Android toolchain into ./.toolchain
# so the repository is fully self-contained and works offline afterwards.
# Idempotent: skips artifacts that already exist. Re-run safely.
# Supports Linux, macOS and Windows (Git Bash/MSYS) hosts; every optional
# platform gap degrades to a warning, never a fatal error.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"
source "$ROOT/versions.env"

mkdir -p "$TOOLCHAIN"
log(){ echo "[setup] $*"; }

# ---- Host OS detection ----
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS_KIND="win" ;;
  Darwin*)              OS_KIND="mac" ;;
  *)                    OS_KIND="linux" ;;
esac

# Platform-specific layout/URL variables (used throughout below).
case "$OS_KIND" in
  win)
    JDK_BIN="jdk/bin/java.exe"          # presence check (-f; exec bits are meaningless on NTFS)
    JDK_OS="windows"                    # Adoptium platform segment
    CTOOLS_OS="win"                     # Google cmdline-tools asset segment
    SDKMGR="sdkmanager.bat"
    AVDMGR="avdmanager.bat"
    ;;
  mac)
    JDK_BIN="jdk/bin/java"
    JDK_OS="mac"
    CTOOLS_OS="mac"
    SDKMGR="sdkmanager"
    AVDMGR="avdmanager"
    ;;
  *)
    JDK_BIN="jdk/bin/java"
    JDK_OS="linux"
    CTOOLS_OS="linux"
    SDKMGR="sdkmanager"
    AVDMGR="avdmanager"
    ;;
esac
# Adoptium arch segments: x64 / aarch64 (uname -m gives x86_64/aarch64/amd64).
JDK_ARCH="$(uname -m | sed 's/x86_64/x64/;s/amd64/x64/;s/aarch64/aarch64/')"
log "Host OS: $OS_KIND ($(uname -s) $(uname -m))"

# ---- Download helper: curl first, wget as fallback ----
download_to(){ # url out
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    log "ERROR: need curl or wget to download $1" >&2
    return 1
  fi
}

# ---- Extract helper: tarballs and zip archives, with Windows fallbacks ----
extract_archive(){ # archive dest
  case "$1" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "$1" -d "$2"
      elif command -v tar >/dev/null 2>&1 && tar -xf "$1" -C "$2" 2>/dev/null; then
        : # bsdtar handles zip
      elif command -v powershell.exe >/dev/null 2>&1; then
        powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '$(cygpath -w "$1")' -DestinationPath '$(cygpath -w "$2")' -Force"
      else
        log "ERROR: need unzip (or perl/python3) to extract $1" >&2
        return 1
      fi
      ;;
    *) tar -xzf "$1" -C "$2" ;;
  esac
}

ok_file(){ # path -> presence/executable check that works on NTFS
  if [ "$OS_KIND" = "win" ]; then [ -f "$1" ]; else [ -x "$1" ]; fi
}

# ---- Node (use system if present, else download) ----
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node $NODE_MAJOR via nvm..."
  if [ ! -d "$HOME/.nvm" ]; then
    download_to https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh /tmp/nvm-install.sh
    bash /tmp/nvm-install.sh
  fi
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
fi

# ---- python3 preflight (needed for frida/mitmproxy dynamic analysis) ----
# A probe over `command -v`: on Windows the Microsoft Store python3 stub exists
# on PATH but runs nothing, which would otherwise be a false positive.
REAL_PY3=0
if command -v python3 >/dev/null 2>&1 && python3 -c "import sys" >/dev/null 2>&1; then
  REAL_PY3=1
fi
if [ "$REAL_PY3" -ne 1 ]; then
  log "WARNING: python3 not found (or not runnable — Windows Store stub?)."
  log "         Required for frida/mitmproxy (dynamic analysis). Core build/test still work without it."
fi

# ---- JDK (auto-download Temurin if no system JDK is present) ----
download_jdk(){ # downloads + extracts the OS/arch-correct Temurin JDK
  JDK_URL="https://api.adoptium.net/v3/binary/latest/${JAVA_MAJOR}/ga/${JDK_OS}/${JDK_ARCH}/jdk/hotspot/normal/eclipse?project=jdk"
  case "$JDK_OS" in windows) JDK_EXT=".zip";; *) JDK_EXT=".tar.gz";; esac
  JDK_PKG="temurin-${JAVA_MAJOR}-jdk-${JDK_OS}-${JDK_ARCH}${JDK_EXT}"
  log "Downloading Temurin JDK ${JAVA_MAJOR} for ${JDK_OS}/${JDK_ARCH}..."
  download_to "$JDK_URL" "/tmp/$JDK_PKG"
  rm -rf /tmp/temurin-extract && mkdir -p /tmp/temurin-extract
  extract_archive "/tmp/$JDK_PKG" /tmp/temurin-extract
}

if ! ok_file "$TOOLCHAIN/$JDK_BIN"; then
  if command -v java >/dev/null 2>&1 && java -version >/dev/null 2>&1; then
    log "Reusing system JDK: $(java -version 2>&1 | head -1)"
    SYSJDK="$(dirname "$(dirname "$(readlink -f "$(command -v java)" 2>/dev/null || command -v java)")")"
    mkdir -p "$TOOLCHAIN/jdk"
    # Copy rather than symlink for Windows (NTFS exec bits / junction quirks).
    if [ "$OS_KIND" = "win" ]; then
      cp -a "$SYSJDK"/. "$TOOLCHAIN/jdk/" 2>/dev/null || true
    else
      ln -sfn "$SYSJDK"/* "$TOOLCHAIN/jdk/" 2>/dev/null || true
    fi
    ok_file "$TOOLCHAIN/$JDK_BIN" || { log "System JDK copy failed; falling back to download."; download_jdk; EXTRACTED="$(ls -d /tmp/temurin-extract/jdk-* 2>/dev/null | head -1)"; [ -n "$EXTRACTED" ] && cp -a "$EXTRACTED"/. "$TOOLCHAIN/jdk/"; }
  else
    download_jdk
    # Temurin tarballs/zips extract to a single jdk-* directory.
    EXTRACTED="$(ls -d /tmp/temurin-extract/jdk-* 2>/dev/null | head -1)"
    if [ -z "$EXTRACTED" ] || { ! ok_file "$EXTRACTED/bin/java.exe" && ! ok_file "$EXTRACTED/bin/java"; }; then
      echo "ERROR: Temurin JDK download/extraction failed. Install manually from https://adoptium.net" >&2
      exit 1
    fi
    cp -a "$EXTRACTED"/. "$TOOLCHAIN/jdk/"
  fi
fi
if ! ok_file "$TOOLCHAIN/$JDK_BIN"; then
  echo "ERROR: JDK not found. Install Temurin JDK $JAVA_MAJOR (https://adoptium.net) and re-run." >&2
  exit 1
fi

# ---- Android SDK command-line tools ----
SDK="$TOOLCHAIN/android-sdk"
if ! ok_file "$SDK/cmdline-tools/latest/bin/$SDKMGR"; then
  log "Downloading Android command-line tools..."
  mkdir -p "$SDK/cmdline-tools"
  ZIP="commandlinetools-${CTOOLS_OS}-${CMDLINE_TOOLS_VERSION}_latest.zip"
  if [ ! -f "/tmp/$ZIP" ]; then
    download_to "https://dl.google.com/android/repository/$ZIP" "/tmp/$ZIP"
  fi
  rm -rf /tmp/cmdline-tools-extract
  mkdir -p /tmp/cmdline-tools-extract
  extract_archive "/tmp/$ZIP" /tmp/cmdline-tools-extract
  rm -rf "$SDK/cmdline-tools/latest"
  mkdir -p "$SDK/cmdline-tools"
  mv /tmp/cmdline-tools-extract/cmdline-tools "$SDK/cmdline-tools/latest"
fi

export JAVA_HOME="$TOOLCHAIN/jdk"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"

# ---- Host architecture / acceleration preflight ----
HOST_ARCH="$(uname -m)"
log "Host arch: $HOST_ARCH"
if [ "$HOST_ARCH" = "x86_64" ]; then
  IMG_ABI="x86_64"
elif [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
  IMG_ABI="arm64-v8a"
else
  echo "ERROR: unsupported host arch $HOST_ARCH (need x86_64 or arm64)." >&2
  exit 1
fi

case "$OS_KIND" in
  linux)
    if [ ! -e /dev/kvm ]; then
      log "WARNING: /dev/kvm not present. The x86_64 emulator CANNOT run without KVM."
      log "Fix:  sudo apt install -y qemu-kvm && sudo gpasswd -a \$USER kvm  (then log out/in)."
    elif [ ! -w /dev/kvm ]; then
      log "WARNING: /dev/kvm exists but is not writable for this user. Emulator will fail."
      log "Fix:  sudo gpasswd -a \$USER kvm  then log out/in."
    else
      log "KVM available: yes"
    fi
    ;;
  win)
    log "Windows acceleration: the emulator uses the Android Emulator Hypervisor Driver (AEHD)"
    log "or Hyper-V/WSL2. See docs/troubleshooting.md (Windows / WSL2 prerequisites for /dev/kvm)."
    ;;
  mac)
    log "macOS acceleration: Hypervisor.framework (hvf) is used automatically; no KVM needed."
    ;;
esac

# ---- Accept licenses + install packages ----
log "Installing Android SDK packages (platform-tools, $ANDROID_PLATFORM, build-tools, emulator, system image)..."
yes | "$SDKMGR" --licenses >/dev/null 2>&1 || log "WARNING: license acceptance failed (continuing; sdkmanager install may prompt/retry)"

# Arch-aware image selection (must match host CPU)
SYSTEM_IMAGE="system-images;$ANDROID_PLATFORM;google_apis;$IMG_ABI"

install_sdk() {
  local img="$1"
  for attempt in 1 2 3; do
    log "sdkmanager attempt $attempt for image $img"
    if "$SDKMGR" --install \
        "platform-tools" \
        "platforms;$ANDROID_PLATFORM" \
        "build-tools;$ANDROID_BUILD_TOOLS" \
        "emulator" \
        "$img"; then
      return 0
    fi
    log "attempt $attempt failed; cleaning partial download and retrying..."
    rm -rf "$SDK/system-images" 2>/dev/null || true
    sleep 3
  done
  return 1
}

if ! install_sdk "$SYSTEM_IMAGE"; then
  log "Primary system image failed; falling back to default (no Google APIs) image..."
  FALLBACK="system-images;$ANDROID_PLATFORM;default;$IMG_ABI"
  if install_sdk "$FALLBACK"; then
    SYSTEM_IMAGE="$FALLBACK"
  else
    log "WARNING: could not install any system image. Emulator AVD will be skipped."
    SYSTEM_IMAGE=""
  fi
fi

# create AVD only if a system image is available
if [ -n "$SYSTEM_IMAGE" ] && ! emulator -list-avds 2>/dev/null | grep -qx "$AVD_NAME"; then
  log "Creating AVD $AVD_NAME..."
  echo "no" | "$AVDMGR" create avd -n "$AVD_NAME" \
    -k "$SYSTEM_IMAGE" -d "$AVD_DEVICE" 2>/dev/null || true
fi

# ---- Vendored dynamic-analysis tooling (frida + mitmproxy) ----
# The venv is gated on a stamp holding all three pins, so bumping any pin in
# versions.env reinstalls instead of silently keeping stale packages.
VENV="$TOOLCHAIN/python-venv"
VENV_STAMP="$VENV/.pins"
# Windows venvs use Scripts\*.exe; POSIX venvs use bin/<name>.
case "$OS_KIND" in
  win) VENV_BIN_DIR="$VENV/Scripts"; PIP_REL="Scripts/pip.exe"; FRIDA_REL="Scripts/frida.exe" ;;
  *)   VENV_BIN_DIR="$VENV/bin";      PIP_REL="bin/pip";          FRIDA_REL="bin/frida" ;;
esac
VENV_PINS="frida==${FRIDA_VERSION}
frida-tools==${FRIDA_TOOLS_VERSION}
mitmproxy==${MITMPROXY_VERSION}"
if [ "$REAL_PY3" -eq 1 ]; then
  if [ ! -f "$VENV/$FRIDA_REL" ] || [ ! -f "$VENV_STAMP" ] \
     || [ "$(cat "$VENV_STAMP")" != "$VENV_PINS" ]; then
    log "Creating python venv (frida $FRIDA_VERSION, frida-tools $FRIDA_TOOLS_VERSION, mitmproxy $MITMPROXY_VERSION)..."
    if { python3 -m venv "$VENV" 2>/dev/null || virtualenv "$VENV" 2>/dev/null; } && "$VENV/$PIP_REL" install --quiet \
        "frida==${FRIDA_VERSION}" \
        "frida-tools==${FRIDA_TOOLS_VERSION}" \
        "mitmproxy==${MITMPROXY_VERSION}"; then
      # Stamp last, only after a successful install, so failures retry next run.
      printf '%s\n' "$VENV_PINS" > "$VENV_STAMP"
    else
      log "WARNING: venv setup failed (need python3-venv or virtualenv); frida/net_capture tools unavailable"
    fi
  fi
fi
FRIDA_DIR="$TOOLCHAIN/frida"
mkdir -p "$FRIDA_DIR"
for ASSET_ARCH in x86_64 arm64; do
  F="$FRIDA_DIR/frida-server-${FRIDA_VERSION}-android-${ASSET_ARCH}"
  if [ ! -f "$F" ]; then
    log "Downloading frida-server $FRIDA_VERSION ($ASSET_ARCH)..."
    if ! curl -fsSL "https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/frida-server-${FRIDA_VERSION}-android-${ASSET_ARCH}.xz" -o "$F.xz"; then
      rm -f "$F.xz"
      log "WARNING: frida-server $ASSET_ARCH download failed (dynamic analysis unavailable for this ABI)"
    elif ! unxz -f "$F.xz"; then
      log "WARNING: could not decompress frida-server $ASSET_ARCH (install xz-utils: sudo apt install -y xz-utils)"
    fi
  fi
done

# ---- Gradle ----
if ! ok_file "$TOOLCHAIN/gradle/bin/gradle" && ! ok_file "$TOOLCHAIN/gradle/bin/gradle.bat"; then
  log "Downloading Gradle $GRADLE_VERSION..."
  mkdir -p "$TOOLCHAIN/gradle"
  GZIP="gradle-${GRADLE_VERSION}-bin.zip"
  [ -f "/tmp/$GZIP" ] || download_to "https://services.gradle.org/distributions/$GZIP" "/tmp/$GZIP"
  rm -rf /tmp/gradle-extract && mkdir -p /tmp/gradle-extract
  extract_archive "/tmp/$GZIP" /tmp/gradle-extract
  rm -rf "$TOOLCHAIN/gradle"/*
  mv /tmp/gradle-extract/gradle-"$GRADLE_VERSION"/* "$TOOLCHAIN/gradle/"
fi

# ---- Maestro ----
if ! ok_file "$TOOLCHAIN/maestro/bin/maestro" && ! ok_file "$TOOLCHAIN/maestro/bin/maestro.exe"; then
  log "Downloading Maestro..."
  mkdir -p "$TOOLCHAIN/maestro"
  # Reuse system maestro if present
  if command -v maestro >/dev/null 2>&1; then
    SYSM="$(dirname "$(dirname "$(readlink -f "$(command -v maestro)" 2>/dev/null || command -v maestro)")")"
    cp -a "$SYSM"/. "$TOOLCHAIN/maestro/" 2>/dev/null || true
  else
    curl -fsSL "https://get.maestro.mobile.dev" | bash >/dev/null 2>&1 || true
    if [ -d "$HOME/.maestro" ]; then
      cp -a "$HOME/.maestro"/. "$TOOLCHAIN/maestro/" 2>/dev/null || true
    fi
  fi
fi

# ---- Android skills repo (shallow clone) ----
if [ ! -d "$TOOLCHAIN/android-skills/.git" ]; then
  log "Cloning android/skills (shallow)..."
  git clone --depth 1 https://github.com/android/skills.git "$TOOLCHAIN/android-skills" 2>/dev/null || true
fi

# ---- compose-preview CLI (compose-ai-tools) — best effort ----
if ! command -v compose-preview >/dev/null 2>&1; then
  log "Installing compose-ai-tools (compose-preview CLI)..."
  if curl -fsSL "https://raw.githubusercontent.com/yschimke/skills/main/scripts/install.sh" | bash >/dev/null 2>&1; then
    log "compose-preview installed."
  else
    log "WARNING: compose-preview install failed (optional). Install later: https://github.com/yschimke/compose-ai-tools"
  fi
fi

# ---- Android CLI (Google agent CLI) — best effort; Linux-only installer URL ----
if ! command -v android >/dev/null 2>&1; then
  if [ "$OS_KIND" = "linux" ] && [ "$HOST_ARCH" = "x86_64" ]; then
    log "Installing Android CLI..."
    if curl -fsSL "https://dl.google.com/android/cli/latest/linux_x86_64/install.sh" | bash >/dev/null 2>&1; then
      log "Android CLI installed."
    else
      log "WARNING: Android CLI install failed (optional). Install later: https://developer.android.com/tools/agents/android-cli/download"
    fi
  else
    log "WARNING: Android CLI auto-install not available for $OS_KIND (optional). Install later: https://developer.android.com/tools/agents/android-cli/download"
  fi
fi

# ---- npm deps for MCP server ----
log "Installing MCP server npm dependencies (including dev deps for build)..."
cd "$ROOT"
npm install
npm run build

# ---- Expose skills to OpenCode (project-level discovery) ----
mkdir -p "$ROOT/.opencode"
ln -sfn ../skills "$ROOT/.opencode/skills" 2>/dev/null || true

# ---- Write env.sh ----
cat > "$TOOLCHAIN/env.sh" <<EOF
# Source this file to use the vendored toolchain: source .toolchain/env.sh
export JAVA_HOME="$TOOLCHAIN/jdk"
export ANDROID_HOME="$TOOLCHAIN/android-sdk"
export ANDROID_SDK_ROOT="$TOOLCHAIN/android-sdk"
export GRADLE_HOME="$TOOLCHAIN/gradle"
export MAESTRO_HOME="$TOOLCHAIN/maestro"
export GRADLE_USER_HOME="$TOOLCHAIN/gradle-home"
export PATH="$VENV_BIN_DIR:\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$GRADLE_HOME/bin:\$MAESTRO_HOME/bin:\$PATH"
EOF

# ---- Warm Gradle dependency cache (enables offline builds later) ----
if ok_file "$ROOT/.toolchain/gradle/bin/gradle" || ok_file "$ROOT/.toolchain/gradle/bin/gradle.bat"; then
  log "Warming Gradle dependency cache (one-time online build)..."
  bash "$ROOT/scripts/warm-cache.sh" || log "WARNING: warm-cache failed; offline builds may not resolve until run once online."
fi

# ---- Auto-register with OpenCode (MCP + skills) ----
bash "$ROOT/scripts/register.sh" || log "WARNING: OpenCode registration skipped (see output above)."

log "Setup complete. Source the toolchain with: source .toolchain/env.sh"
log "Run 'make doctor' to verify."
