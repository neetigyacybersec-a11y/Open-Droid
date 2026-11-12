# syntax=docker/dockerfile:1.7
# Multi-stage build for android-mcp.
# Stage 1: build the TypeScript MCP server.
# Stage 2: runtime image with JDK + Android SDK + emulator + MCP server.

# ---------- Stage 1: builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM eclipse-temurin:21-jdk AS runtime
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget unzip curl ca-certificates python3 \
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

# Android SDK
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && cd /tmp \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -O cmdline.zip \
    && unzip -q cmdline.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm cmdline.zip

# Issue 73: required SDK components must fail closed — a missing platform
# image silently breaks every downstream job.
RUN yes | sdkmanager --licenses >/dev/null
RUN sdkmanager --install \
        "platform-tools" \
        "platforms;android-35" \
        "build-tools;35.0.0" \
        "emulator" \
        "system-images;android-35;default;x86_64"

RUN echo "no" | avdmanager create avd -n Pixel_9_API_35 \
        -k "system-images;android-35;default;x86_64" -d pixel_9

# Maestro: pinned release zip (same version vendored locally), not the
# unpinned "latest" installer (issue 73).
RUN mkdir -p /opt/maestro \
    && wget -q "https://github.com/mobile-dev-inc/maestro/releases/download/cli-2.12.1/maestro.zip" -O /tmp/maestro.zip \
    && unzip -q /tmp/maestro.zip -d /tmp/maestro-extract \
    && cp -a /tmp/maestro-extract/maestro/. /opt/maestro/ \
    && rm -rf /tmp/maestro.zip /tmp/maestro-extract
ENV PATH="/opt/maestro/bin:${PATH}"

# App
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
COPY scripts/run-mcp.sh ./scripts/run-mcp.sh
# Normalize line endings so a Windows (CRLF) checkout can't break the shebang.
RUN sed -i 's/\r$//' ./scripts/run-mcp.sh && chmod +x ./scripts/run-mcp.sh

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
ENTRYPOINT ["./scripts/run-mcp.sh"]
