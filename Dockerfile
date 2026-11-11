# syntax=docker/dockerfile:1
# HDS Node backend image (plan 102), from `infra/dev-deploy/templates/Dockerfile.node-service`.
#
# Differs from the template in one way: this repo HAS a build step (TypeScript to `dist/`, `npm run build`, also
# run by the root `prepare` script). So the deps stage installs everything, builds, then prunes devDependencies,
# and the runtime stage ships `dist/` instead of `src/`. Entry: `node dist/httpMain.js` (`hds-mcp-http`).


# ---------------------------------------------------------------------------
# Base image is DIGEST-PINNED and must not float (see the template for why).
# Keep NODE_VERSION in `.github/workflows/build-image.yml` equal to this version.
# Re-pin with: docker buildx imagetools inspect node:24.22.1-slim
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# --- deps + build -----------------------------------------------------------
FROM ${NODE_IMAGE} AS deps

# git: dependencies are git URLs (hds-observability-js), built by their own `prepare`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.build.json ./
COPY src ./src

# Lockfile `resolved` URLs are git+ssh; the repos are public, so rewrite to https and no deploy key is needed.
# `npm ci` runs the root `prepare` (= `npm run build`), which needs the devDependencies; prune them afterwards.
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
 && git config --global url."https://github.com/".insteadOf "git@github.com:" \
 && npm ci \
 && test -f dist/httpMain.js \
 && npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM ${NODE_IMAGE}

# herokuish parity: the process runs as uid/gid 32767.
RUN groupadd -g 32767 app && useradd -u 32767 -g 32767 -d /app -M app

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/dist ./dist
# Read at runtime: `dist/server.js` reads ../package.json for name and version (/status, MCP server info).
COPY package.json ./
# Deploy-time healthcheck on /status (B-2026-10-02-4): Dokku reads app.json only from the image WORKDIR.
COPY app.json ./

# Nothing is written under /app at runtime (logs go to stderr). /app/data exists for parity with the other
# services, in case a storage mount is ever added.
RUN mkdir -p /app/data/logs && chown -R 32767:32767 /app/data

ARG SOURCE_COMMIT=unknown
ARG IMAGE_VERSION=unknown
ARG BUILD_DATE=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT} \
    IMAGE_VERSION=${IMAGE_VERSION} \
    BUILD_DATE=${BUILD_DATE}

# Read by the deploy-time skew assertions (plan 102): the running container's
# revision label must equal the commit the tag points at.
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT} \
      org.opencontainers.image.version=${IMAGE_VERSION} \
      org.opencontainers.image.source=https://github.com/healthdatasafe

USER 32767

# PER-APP: the port the service listens on. httpMain reads PORT; ENV makes the image default agree with EXPOSE.
# Keep `dokku ports:set hds-mcp http:80:7450 https:443:7450` in agreement.
ARG PORT=7450
ENV PORT=${PORT}
EXPOSE ${PORT}

CMD ["node", "dist/httpMain.js"]
