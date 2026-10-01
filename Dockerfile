# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three targets:
#   docker build --target web    -t labelconsole-web .
#   docker build --target worker -t labelconsole-worker .
# The worker image also carries the release steps:
#   docker run --rm labelconsole-worker node dist/setup.js     # once, fresh Postgres only
#   docker run --rm labelconsole-worker node dist/migrate.js   # every deploy, before new code starts
#
# Behind a TLS-inspecting proxy, pass its CA for the dependency download:
#   docker build --secret id=npm_ca,src=/path/to/ca.pem ...

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# Dependencies from the lockfile alone, so this layer is reused until the lockfile changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    pnpm fetch

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter @labelconsole/web build && pnpm --filter @labelconsole/worker build

# The worker bundle inlines the workspace packages, so its image needs only its own
# runtime dependencies: a production install of that one project, pinned by the lockfile.
# Starts from base, not deps: `pnpm fetch` fills node_modules/.pnpm with every package in
# the lockfile, and those would ride along. Packages come from the shared store cache.
FROM base AS worker-deps
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    pnpm install --prefer-offline --frozen-lockfile --prod --filter @labelconsole/worker

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
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
