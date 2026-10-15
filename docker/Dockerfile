# syntax=docker/dockerfile:1
# ── Android toolchain base (shared by dev + runtime; PLAN: containers only, no DinD) ──
# Ubuntu 24.04 + JDK 21 + Android SDK 35 + pinned Gradle + Node 24. The web
# container builds the per-user APKs in-process (lib/apk-builder.ts spawns
# gradle as the app user). Kept glibc (Ubuntu): Android build-tools do not run
# on musl, hence dev/runtime moved off Alpine.
FROM ubuntu:24.04 AS toolchain
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip tini gosu openjdk-21-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
# Node.js runtime (binaries + npm/corepack) copied from the official image.
COPY --from=node:24-bookworm-slim /usr/local /usr/local
# Bundled MCP server: ketch (static Go binary) — spawned via `ketch mcp serve`
# (stdio). Headless-Chrome JS rendering is NOT bundled (scraping still works
# without JS). Pinned by ARG; see README "Tools (MCP)".
ARG KETCH_VERSION=0.18.1
RUN arch=$(dpkg --print-architecture) \
    && case "$arch" in amd64) ka=x86_64;; arm64) ka=arm64;; esac \
    && curl -fsSL "https://github.com/1broseidon/ketch/releases/download/v${KETCH_VERSION}/ketch_${KETCH_VERSION}_linux_${ka}.tar.gz" -o /tmp/k.tgz \
    && tar -xzf /tmp/k.tgz -C /usr/local/bin ketch && chmod 0755 /usr/local/bin/ketch \
    && ketch version
# Android SDK (cmdline-tools, platforms;35, build-tools;35.0.0, platform-tools,
# licenses accepted) from the same image the android/ dev flow uses.
COPY --from=ghcr.io/cirruslabs/android-sdk:35 /opt/android-sdk-linux /opt/android-sdk-linux
# The Gradle SDK auto-installer (build-tools components not baked in the SDK
# image) writes into $ANDROID_HOME at APK-build time as the app user → keep it
# world-writable in every stage (rootless containers, no chown at boot).
RUN chmod -R a+rwX /opt/android-sdk-linux
ARG GRADLE_VERSION=8.9
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip \
    && gradle --version
ENV ANDROID_HOME=/opt/android-sdk-linux \
    ANDROID_SDK_ROOT=/opt/android-sdk-linux \
    JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 \
    GRADLE_USER_HOME=/opt/gradle-home

# ── Gradle cache pre-warm (bakes deps so per-user builds skip cold downloads) ──
FROM toolchain AS apk-prewarm
COPY android/ /opt/yasha-android/
RUN gradle --no-daemon -p /opt/yasha-android assembleDebug \
    && find /opt/yasha-android \( -type d \( -name build -o -name .gradle \) \) -prune -exec rm -rf {} + \
    && chmod -R a+rwX /opt/gradle-home

# ── Dev stage (named target `dev`) ────────────────────────────────────────────
# Deps are BAKED (npm ci + native build toolchain); the live source tree is
# bind-mounted at runtime (see compose.override.yml.example) with a named
# volume guarding /app/node_modules. Nothing installs at container boot.
FROM toolchain AS dev
# better-sqlite3 native fallback compilation (prebuilds usually hit)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY --from=apk-prewarm /opt/gradle-home /opt/gradle-home
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG ALLOWED_DEV_ORIGINS=
# NOTE: no NODE_ENV here — `next dev` forces development itself, and baking
# NODE_ENV=development would break `npm run build` in this same image.
ENV NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    ALLOWED_DEV_ORIGINS=${ALLOWED_DEV_ORIGINS} \
    YASHA_APK_SOURCE_DIR=/app/android \
    YASHA_APK_BUILD_DIR=/data/apk-builds
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT []
CMD ["npm", "run", "dev"]

# ── Build stage (Next standalone; no Android toolchain needed) ────────────────
# glibc (Debian) to match the runtime base (Ubuntu): the better-sqlite3 native
# binding compiled here is copied into the runtime image via .next/standalone.
FROM node:24-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    LEMONADE_BASE_URL=http://localhost:13305 \
    BETTER_AUTH_SECRET=build-time-only-not-a-real-secret-0000000000 \
    BETTER_AUTH_URL=http://localhost
# Placeholders above only satisfy module-level env validation during
# `next build`'s page-data collection; real values are supplied at container
# runtime (never baked — they only live in this build stage).
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM toolchain AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/yasha.db \
    YASHA_APK_SOURCE_DIR=/opt/yasha-android \
    YASHA_APK_BUILD_DIR=/data/apk-builds
WORKDIR /app
RUN groupadd -g 10001 yasha && useradd -u 10001 -g yasha -M -s /usr/sbin/nologin yasha && mkdir -p /data && chown yasha:yasha /data
# Next.js standalone output (traced node_modules incl. better-sqlite3 native binding)
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
# Android sources + pre-warmed gradle cache for in-container APK builds
# (--chown: gradle (run as the app user) chmods files under GRADLE_USER_HOME;
# root-owned dirs → EPERM "Could not set UNIX mode" and the build fails)
COPY --chown=yasha:yasha --from=apk-prewarm /opt/yasha-android /opt/yasha-android
COPY --chown=yasha:yasha --from=apk-prewarm /opt/gradle-home /opt/gradle-home
COPY --chown=yasha:yasha docker/entrypoint.sh /entrypoint.sh
# Starts as root only to chown the bind-mounted /data, then drops to yasha (see entrypoint.sh)
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server.js"]
