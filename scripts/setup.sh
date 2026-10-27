#!/usr/bin/env bash
# One-command bootstrap: downloads the entire Android toolchain into ./.toolchain
# so the repository is fully self-contained and works offline afterwards.
# Idempotent: skips artifacts that already exist. Re-run safely.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN="$ROOT/.toolchain"
source "$ROOT/versions.env"

mkdir -p "$TOOLCHAIN"
log(){ echo "[setup] $*"; }

# ---- Node (use system if present, else download) ----
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  log "Installing Node $NODE_MAJOR via nvm..."
  if [ ! -d "$HOME/.nvm" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
fi

# ---- JDK ----
if [ ! -x "$TOOLCHAIN/jdk/bin/java" ]; then
  log "Downloading Temurin JDK $JAVA_MAJOR..."
  mkdir -p "$TOOLCHAIN/jdk"
  # Use system JDK if available and matches
  if command -v java >/dev/null 2>&1; then
    log "Reusing system JDK: $(java -version 2>&1 | head -1)"
    # symlink system JDK
    SYSJDK="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
    ln -sfn "$SYSJDK"/* "$TOOLCHAIN/jdk/" 2>/dev/null || true
  fi
fi
if [ ! -x "$TOOLCHAIN/jdk/bin/java" ]; then
  echo "ERROR: JDK not found. Install Temurin JDK $JAVA_MAJOR (https://adoptium.net) and re-run." >&2
  exit 1
fi

# ---- Android SDK command-line tools ----
SDK="$TOOLCHAIN/android-sdk"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  log "Downloading Android command-line tools..."
  mkdir -p "$SDK/cmdline-tools"
  cd /tmp
  ZIP="commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip"
  if [ ! -f "/tmp/$ZIP" ]; then
    wget -q "https://dl.google.com/android/repository/$ZIP" -O "/tmp/$ZIP"
  fi
  rm -rf /tmp/cmdline-tools-extract
  mkdir -p /tmp/cmdline-tools-extract
  unzip -q "/tmp/$ZIP" -d /tmp/cmdline-tools-extract
  rm -rf "$SDK/cmdline-tools/latest"
  mkdir -p "$SDK/cmdline-tools"
  mv /tmp/cmdline-tools-extract/cmdline-tools "$SDK/cmdline-tools/latest"
fi

export JAVA_HOME="$TOOLCHAIN/jdk"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"

# ---- Accept licenses + install packages ----
log "Installing Android SDK packages (platform-tools, $ANDROID_PLATFORM, build-tools, emulator, system image)..."
yes | sdkmanager --licenses >/dev/null 2>&1 || true

# Arch-aware image selection (must match host CPU)
SYSTEM_IMAGE="system-images;$ANDROID_PLATFORM;google_apis;$IMG_ABI"
# ---- Host architecture / KVM preflight ----
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

# KVM check: x86_64 emulator requires hardware acceleration
if [ "$IMG_ABI" = "x86_64" ]; then
  if [ ! -e /dev/kvm ]; then
    log "WARNING: /dev/kvm not present. The x86_64 emulator CANNOT run without KVM."
    log "Fix:  sudo apt install -y qemu-kvm && sudo gpasswd -a \$USER kvm  (then log out/in)."
  elif [ ! -w /dev/kvm ]; then
    log "WARNING: /dev/kvm exists but is not writable for this user. Emulator will fail."
    log "Fix:  sudo gpasswd -a \$USER kvm  (then log out/in)."
  else
    log "KVM available: yes"
  fi
fi

install_sdk() {
  local img="$1"
  for attempt in 1 2 3; do
    log "sdkmanager attempt $attempt for image $img"
    if sdkmanager --install \
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
  echo "no" | avdmanager create avd -n "$AVD_NAME" \
    -k "$SYSTEM_IMAGE" -d "$AVD_DEVICE" 2>/dev/null || true
fi
# skip the original AVD block below by guarding
_AVDS_DONE=1

# ---- Gradle ----
if [ ! -x "$TOOLCHAIN/gradle/bin/gradle" ]; then
  log "Downloading Gradle $GRADLE_VERSION..."
  mkdir -p "$TOOLCHAIN/gradle"
  cd /tmp
  GZIP="gradle-${GRADLE_VERSION}-bin.zip"
  if [ ! -f "/tmp/$GZIP" ]; then
    wget -q "https://services.gradle.org/distributions/$GZIP" -O "/tmp/$GZIP"
  fi
  rm -rf /tmp/gradle-extract && mkdir -p /tmp/gradle-extract
  unzip -q "/tmp/$GZIP" -d /tmp/gradle-extract
  rm -rf "$TOOLCHAIN/gradle"/*
  mv /tmp/gradle-extract/gradle-"$GRADLE_VERSION"/* "$TOOLCHAIN/gradle/"
fi

# ---- Maestro ----
if [ ! -x "$TOOLCHAIN/maestro/bin/maestro" ]; then
  log "Downloading Maestro..."
  mkdir -p "$TOOLCHAIN/maestro"
  # Reuse system maestro if present
  if command -v maestro >/dev/null 2>&1; then
    SYSM="$(dirname "$(dirname "$(readlink -f "$(command -v maestro)")")")"
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

# ---- Android CLI (Google agent CLI) — best effort ----
if ! command -v android >/dev/null 2>&1; then
  log "Installing Android CLI..."
  if curl -fsSL "https://dl.google.com/android/cli/latest/linux_x86_64/install.sh" | bash >/dev/null 2>&1; then
    log "Android CLI installed."
  else
    log "WARNING: Android CLI install failed (optional). Install later: https://developer.android.com/tools/agents/android-cli/download"
  fi
fi

# ---- npm deps for MCP server ----
log "Installing MCP server npm dependencies..."
cd "$ROOT"
npm install --omit=dev 2>/dev/null || npm install
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
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/emulator:\$GRADLE_HOME/bin:\$MAESTRO_HOME/bin:\$PATH"
EOF

# ---- Warm Gradle dependency cache (enables offline builds later) ----
if [ -x "$ROOT/.toolchain/gradle/bin/gradle" ]; then
  log "Warming Gradle dependency cache (one-time online build)..."
  bash "$ROOT/scripts/warm-cache.sh" || log "WARNING: warm-cache failed; offline builds may not resolve until run once online."
fi

log "Setup complete. Source the toolchain with: source .toolchain/env.sh"
log "Run 'make doctor' to verify."
