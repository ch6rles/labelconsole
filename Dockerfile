# syntax=docker/dockerfile:1.7
#
# One Dockerfile, two images:
#   docker build --target web    -t labelconsole-web .
#   docker build --target worker -t labelconsole-worker .
# Hosts that can't pick a target (Railway) build the last stage, `app`: one image
# holding both, which starts the worker when LC_TARGET=worker is set at runtime
# and the web app otherwise:
#   docker build -t labelconsole .
# The worker image also carries the release steps:
#   docker run --rm labelconsole-worker node dist/setup.js     # once, fresh Postgres only
#   docker run --rm labelconsole-worker node dist/migrate.js   # every deploy, before new code starts
#   docker run --rm -it labelconsole-worker node dist/owner.js --email you@example.com   # add an owner or reset a password
#   (in the combined image: cd /opt/worker/apps/worker && node dist/owner.js --email …)
#
# Behind a TLS-inspecting proxy, pass its CA certificate (public, not a secret) for downloads:
#   docker build --build-arg NPM_CA="$(cat /path/to/ca.pem)" ...
#
# No BuildKit cache or secret mounts: Railway only accepts cache mounts with its own
# per-service ids. Docker's layer cache still skips installs until the lockfile changes.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG NPM_CA
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN if [ -n "$NPM_CA" ]; then printf '%s\n' "$NPM_CA" > /tmp/npm-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# Dependencies from the lockfile alone, so this layer is reused until the lockfile changes.
FROM base AS deps
ARG NPM_CA
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN if [ -n "$NPM_CA" ]; then printf '%s\n' "$NPM_CA" > /tmp/npm-ca.pem; export NODE_EXTRA_CA_CERTS=/tmp/npm-ca.pem; fi; \
    pnpm fetch --store-dir /pnpm/store

FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
RUN pnpm --filter @labelconsole/web build && pnpm --filter @labelconsole/worker build

# The worker bundle inlines the workspace packages, so its image needs only its own
# runtime dependencies: a production install of that one project, pinned by the lockfile.
# Starts from base, not deps, so only this project's packages end up in node_modules;
# they are installed from the store `deps` already downloaded.
FROM base AS worker-deps
COPY --from=deps /pnpm/store /pnpm/store
COPY . .
RUN pnpm install --offline --frozen-lockfile --prod --filter @labelconsole/worker --store-dir /pnpm/store

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 LC_MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# The web app applies migrations itself when its database URLs are derived (Railway).
COPY --from=build --chown=node:node /repo/packages/core/migrations ./migrations
# Local file storage (STORAGE_DRIVER=local); mount a volume here, or use S3/R2 in production.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]

FROM node:${NODE_VERSION}-bookworm-slim AS worker
ENV NODE_ENV=production LC_PROCESS=worker LC_MIGRATIONS_DIR=/app/migrations WORKER_HEALTH_PORT=9091
WORKDIR /app
# Keep pnpm's layout (apps/worker/node_modules links into node_modules/.pnpm).
COPY --from=worker-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=worker-deps --chown=node:node /repo/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=worker-deps --chown=node:node /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /repo/packages/core/migrations ./migrations
RUN mkdir -p /data/storage && chown node:node /data/storage
WORKDIR /app/apps/worker
USER node
EXPOSE 9091
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9091/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# SIGTERM lets active jobs finish (up to 60s) before exit; give the container at least that long to stop.
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]

# The default (last) stage, for hosts that build one image per service from the
# same Dockerfile: both apps, chosen when the container starts. LC_TARGET=worker
# runs the worker; anything else runs the web app. A runtime choice can't be lost
# the way a build argument can.
FROM node:${NODE_VERSION}-bookworm-slim AS app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 LC_MIGRATIONS_DIR=/app/migrations WORKER_HEALTH_PORT=9091
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/packages/core/migrations ./migrations
# The worker keeps pnpm's layout under its own root, apart from the web app's traced node_modules.
COPY --from=worker-deps --chown=node:node /repo/node_modules /opt/worker/node_modules
COPY --from=worker-deps --chown=node:node /repo/apps/worker/node_modules /opt/worker/apps/worker/node_modules
COPY --from=worker-deps --chown=node:node /repo/apps/worker/package.json /opt/worker/apps/worker/package.json
COPY --from=build --chown=node:node /repo/apps/worker/dist /opt/worker/apps/worker/dist
RUN mkdir -p /data/storage && chown node:node /data/storage \
 && printf '%s\n' '#!/bin/sh' \
    'if [ "$LC_TARGET" = "worker" ]; then' \
    '  export LC_PROCESS=worker; cd /opt/worker/apps/worker && exec node dist/index.js' \
    'fi' \
    'exec node /app/apps/web/server.js' > /usr/local/bin/lc-start \
 && chmod +x /usr/local/bin/lc-start
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["lc-start"]
