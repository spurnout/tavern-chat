# syntax=docker/dockerfile:1.7
#
# Tavern Worker image — Node 22 alpine + BullMQ.
#
# Build context: the workspace root.
#
#   docker build -f apps/worker/Dockerfile -t tavern-worker .
#
# Same multi-stage shape as apps/api/Dockerfile (deps -> builder -> deploy ->
# runtime). The worker runs via tsx for the same reason the api does:
# workspace deps export TS source.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

FROM base AS deps
RUN apk add --no-cache openssl python3 make g++ libc6-compat
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/federation/package.json packages/federation/package.json
COPY e2e/package.json e2e/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @tavern/db generate

FROM builder AS deployer
RUN pnpm --filter @tavern/worker --prod deploy /deploy
# Regenerate the Prisma client into the deploy tree. cwd is the deploy root
# so the prisma CLI (in @tavern/db's devDeps under /app) finds a package.json
# and skips its auto-install fallback.
RUN cd /deploy && /app/packages/db/node_modules/.bin/prisma generate \
    --schema=node_modules/@tavern/db/prisma/schema.prisma

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache libstdc++ openssl tini
COPY --from=deployer --chown=node:node /deploy ./
USER node
ENTRYPOINT ["/sbin/tini", "--"]
# Run tsx via its bin directly — see api/Dockerfile for the rationale.
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "src/index.ts"]
