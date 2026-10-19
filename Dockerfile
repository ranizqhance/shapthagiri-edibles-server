# syntax=docker/dockerfile:1

###############################################################################
# Shreshtam API — NestJS + Sequelize, listens on 5777
#
# Chromium is installed from the distro rather than letting Puppeteer download
# its own bundled build: the download is ~300 MB, needs network at image-build
# time, and pulls a glibc build that Alpine cannot run. `pdf.util.ts` already
# launches with --no-sandbox, which is what makes the system binary usable.
###############################################################################

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------- deps -------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Puppeteer must not fetch Chrome during any npm install in this image.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build -------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `nest build` emits dist/, then tsc-alias rewrites the @/* path aliases so the
# compiled output resolves without tsconfig-paths at runtime.
RUN npm run build

# ---------------------------------------------------- production deps --------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# -------------------------------------------------------------- runner -------
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5777 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Stamped when the image is built, not when it runs. A boot log showing an old
# BUILD_TIME means the deploy reused a cached image rather than rebuilding —
# which is otherwise very hard to tell apart from a code bug.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/BUILD_TIME

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist         ./dist
# ServeStaticModule resolves join(__dirname, '..', 'public') → /app/public
COPY --chown=node:node public ./public
COPY package.json ./
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 5777

# Probes /live, NOT /health. /health calls queueService.getHealth() → Redis
# ping, and the ioredis connection uses `maxRetriesPerRequest: null`, so when
# Redis is unreachable that command queues forever instead of rejecting — the
# request hangs, the probe times out, and Swarm pulls the task out of the
# routing mesh, which surfaces as a 502 at Traefik. /live has no dependencies.
# Reports healthy unconditionally while DEBUG_HOLD=1, otherwise Swarm would
# restart the parked container and destroy the very evidence being inspected.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=5 \
  CMD sh -c '[ "${DEBUG_HOLD:-0}" = "1" ] || curl -fsS "http://127.0.0.1:${PORT}/api/v1/live"'

# Runs the API directly rather than via `npm run start:prod`, which shells out
# to kill-port (a devDependency) against a hardcoded port 4000.
# Set DEBUG_HOLD=1 in the environment to keep the container up after a boot
# failure so the crash can be read with `docker exec`.
CMD ["docker-entrypoint.sh"]
