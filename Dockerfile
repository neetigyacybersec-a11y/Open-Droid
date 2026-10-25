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

# Node 22 (runtime for MCP server)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Android SDK
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && cd /tmp \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline.zip \
    && unzip -q cmdline.zip -d ${ANDROID_HOME}/cmdline-tools \
    && mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm cmdline.zip

RUN yes | sdkmanager --licenses >/dev/null 2>&1 || true
RUN sdkmanager --install \
        "platform-tools" \
        "platforms;android-35" \
        "build-tools;35.0.0" \
        "emulator" \
        "system-images;android-35;default;x86_64" \
    || true

RUN echo "no" | avdmanager create avd -n Pixel_9_API_35 \
        -k "system-images;android-35;default;x86_64" -d pixel_9 2>/dev/null || true

# Maestro (best-effort)
RUN curl -fsSL "https://get.maestro.mobile.dev" | bash 2>/dev/null || true
ENV PATH="/root/.maestro/bin:${PATH}"

# App
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./
COPY scripts/run-mcp.sh ./scripts/run-mcp.sh
RUN chmod +x ./scripts/run-mcp.sh

ENV NODE_ENV=production
ENTRYPOINT ["./scripts/run-mcp.sh"]
