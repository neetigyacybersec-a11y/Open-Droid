# syntax=docker/dockerfile:1.7
# Multi-stage build for android-mcp.
# Stage 1: build the TypeScript MCP server.
# Stage 2: runtime image with every non-device dependency used by the MCP
# handlers: JDK, Android SDK, Gradle, JADX/apktool, Compose Preview, Android
# CLI, Maestro and the pinned Frida/mitmproxy venv plus frida-server assets.
# Device connectivity (USB/KVM/host adb server) stays an explicit external boundary.

# ---------- Stage 1: builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# ISSUE-144: npm run build also writes dist/build-manifest.json.
COPY scripts/build-manifest.mjs ./scripts/build-manifest.mjs
RUN npm run build
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM eclipse-temurin:21-jdk AS runtime
SHELL ["/bin/bash", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget unzip curl ca-certificates python3 python3-venv xz-utils unzip \
        libglu1-mesa libpulse0 libx11-6 libxcb1 libxcomposite1 libxcursor1 \
        libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
        libxtst6 libnss3 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# Node 22: official dist tarball, SHA-256-verified from nodejs.org (issue 73:
# replaces the unpinned `curl nodesource | bash` pipe-to-shell).
ARG NODE_VERSION=22.18.0
RUN cd /tmp \
    && wget -q "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && wget -q "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && grep "node-v${NODE_VERSION}-linux-x64.tar.xz" SHASUMS256.txt | sha256sum -c - \
    && tar -xf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
    && rm -f "node-v${NODE_VERSION}-linux-x64.tar.xz" SHASUMS256.txt

# One manifest for host setup and Docker. versions.env also stays at /app so
# src/frida.ts can read the pinned FRIDA_VERSION at runtime.
COPY versions.env /app/versions.env
COPY frida-scripts/ /app/frida-scripts/

# Android SDK
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
# Kept as Docker ENV so PATH can include the build-tools directory; the test
# suite asserts it matches ANDROID_BUILD_TOOLS in versions.env.
ENV ANDROID_BUILD_TOOLS=35.0.0
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS}:/app/.toolchain/gradle/bin:/app/.toolchain/python-venv/bin:/opt/maestro/bin:/usr/local/bin:${PATH}"

RUN . /app/versions.env && mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && cd /tmp \
    && wget -q "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" -O cmdline.zip \
    && unzip -q cmdline.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm cmdline.zip

# Issue 73: required SDK components must fail closed — a missing platform
# image silently breaks every downstream job.
RUN yes | sdkmanager --licenses >/dev/null
RUN . /app/versions.env && sdkmanager --install \
        "platform-tools" \
        "platforms;${ANDROID_PLATFORM}" \
        "build-tools;${ANDROID_BUILD_TOOLS}" \
        "emulator" \
        "system-images;android-35;default;x86_64"
RUN . /app/versions.env \
    && echo "no" | avdmanager create avd -n "$AVD_NAME" \
        -k "system-images;android-35;default;x86_64" -d "$AVD_DEVICE"

# Gradle: bundled into /app/.toolchain so resolveGradleExecutable() finds it
# without a prepared shell; GRADLE_USER_HOME keeps caches outside read-only /app.
RUN . /app/versions.env \
    && mkdir -p /app/.toolchain/gradle /tmp/gradle-extract \
    && wget -q "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -O /tmp/gradle.zip \
    && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
    && unzip -q /tmp/gradle.zip -d /tmp/gradle-extract \
    && cp -a "/tmp/gradle-extract/gradle-${GRADLE_VERSION}/." /app/.toolchain/gradle/ \
    && rm -rf /tmp/gradle.zip /tmp/gradle-extract

# Frida CLI, frida-ps and mitmdump: pinned pip packages in the same vendored
# venv layout the host bootstrap uses. All handlers resolve them via PATH or
# .toolchain/python-venv/bin.
RUN . /app/versions.env \
    && python3 -m venv /app/.toolchain/python-venv \
    && /app/.toolchain/python-venv/bin/pip install --no-cache-dir --quiet \
        "frida==${FRIDA_VERSION}" \
        "frida-tools==${FRIDA_TOOLS_VERSION}" \
        "mitmproxy==${MITMPROXY_VERSION}"

# ABI-specific frida-server assets, verified against versions.env digests.
RUN . /app/versions.env && mkdir -p /app/.toolchain/frida && cd /tmp \
    && for arch in x86_64 arm64; do \
         case "$arch" in \
           x86_64) digest="$FRIDA_SERVER_X86_64_SHA256" ;; \
           arm64) digest="$FRIDA_SERVER_ARM64_SHA256" ;; \
         esac; \
         wget -q "https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/frida-server-${FRIDA_VERSION}-android-${arch}.xz" -O "frida-${arch}.xz" \
         && echo "${digest}  frida-${arch}.xz" | sha256sum -c - \
         && unxz -c "frida-${arch}.xz" > "/app/.toolchain/frida/frida-server-${FRIDA_VERSION}-android-${arch}" \
         && chmod +x "/app/.toolchain/frida/frida-server-${FRIDA_VERSION}-android-${arch}" \
         && rm -f "frida-${arch}.xz"; \
       done

# Static analysis: JADX and apktool (the host bootstrap does not install these;
# the container must, because apk_decompile calls them directly).
RUN . /app/versions.env && mkdir -p /opt/jadx /opt/apktool \
    && wget -q "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" -O /tmp/jadx.zip \
    && echo "${JADX_SHA256}  /tmp/jadx.zip" | sha256sum -c - \
    && unzip -q /tmp/jadx.zip -d /opt/jadx \
    && rm -f /tmp/jadx.zip \
    && printf '#!/bin/sh\nexec /opt/jadx/bin/jadx "$@"\n' > /usr/local/bin/jadx \
    && chmod +x /usr/local/bin/jadx \
    && wget -q "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar" -O /opt/apktool/apktool.jar \
    && echo "${APKTOOL_SHA256}  /opt/apktool/apktool.jar" | sha256sum -c - \
    && printf '#!/bin/sh\nexec java -jar /opt/apktool/apktool.jar "$@"\n' > /usr/local/bin/apktool \
    && chmod +x /usr/local/bin/apktool

# Compose Preview CLI from the pinned compose-ai-tools release (upstream tarball
# already contains bin/compose-preview and its lib/ tree with license files).
RUN . /app/versions.env && mkdir -p /opt/compose-preview/cli \
    && wget -q "https://github.com/yschimke/compose-ai-tools/releases/download/v${COMPOSE_PREVIEW_VERSION}/compose-preview-${COMPOSE_PREVIEW_VERSION}.tar.gz" -O /tmp/compose-preview.tar.gz \
    && echo "${COMPOSE_PREVIEW_SHA256}  /tmp/compose-preview.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/compose-preview.tar.gz -C /opt/compose-preview/cli \
    && ln -s "/opt/compose-preview/cli/compose-preview-${COMPOSE_PREVIEW_VERSION}/bin/compose-preview" /usr/local/bin/compose-preview \
    && rm -f /tmp/compose-preview.tar.gz

# Android CLI: Google publishes only a mutable /latest/ binary and no checksum.
RUN . /app/versions.env \
    && wget -q "$ANDROID_CLI_URL" -O /usr/local/bin/android \
    && chmod +x /usr/local/bin/android

# Maestro: pinned release zip (same version vendored by scripts/setup.sh), not
# the unpinned "latest" installer (issue 73).
RUN . /app/versions.env && mkdir -p /opt/maestro \
    && wget -q "https://github.com/mobile-dev-inc/maestro/releases/download/${MAESTRO_VERSION}/maestro.zip" -O /tmp/maestro.zip \
    && echo "${MAESTRO_SHA256}  /tmp/maestro.zip" | sha256sum -c - \
    && unzip -q /tmp/maestro.zip -d /tmp/maestro-extract \
    && cp -a /tmp/maestro-extract/maestro/. /opt/maestro/ \
    && rm -rf /tmp/maestro.zip /tmp/maestro-extract

# App
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
COPY scripts/run-mcp.sh scripts/docker-smoke.sh scripts/docker-mcp-smoke.mjs ./scripts/
# Normalize line endings so a Windows (CRLF) checkout can't break the shebang.
RUN sed -i 's/\r$//' ./scripts/run-mcp.sh ./scripts/docker-smoke.sh && chmod +x ./scripts/run-mcp.sh ./scripts/docker-smoke.sh

# Issue 73: run the MCP server as a dedicated non-root user. Android SDK and
# toolchain paths stay root-owned read/execute; per-user state lives in the
# user's home (gradle caches, avds) — no world-writable fallbacks.
RUN useradd --create-home --shell /usr/sbin/nologin mcp \
    && mkdir -p /opt/gradle-home \
    && chown -R mcp:mcp /app /opt/gradle-home
USER mcp
ENV HOME=/home/mcp
ENV NODE_ENV=production
ENV GRADLE_USER_HOME=/opt/gradle-home
# Fail the image build itself when a runtime capability is missing; CI reruns
# the same script against the built image so a successful build is not the only
# evidence.
RUN bash scripts/docker-smoke.sh
ENTRYPOINT ["./scripts/run-mcp.sh"]
