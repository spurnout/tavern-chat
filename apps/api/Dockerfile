# syntax=docker/dockerfile:1.7
#
# Tavern API image — Node 22 alpine + Fastify + Prisma.
#
# Build context: the workspace root (so we can see pnpm-workspace.yaml and
# every package's package.json for a coherent `pnpm install`).
#
#   docker build -f apps/api/Dockerfile -t tavern-api .
#
# Runtime model: `tsx src/index.ts`. Workspace packages (@tavern/shared, db,
# media) export TypeScript source via `main: ./src/index.ts`; Node can't
# load those directly, so the api runs through tsx, which loads TS natively.
# Cost is ~100ms at cold start; in exchange we don't need to publish/bundle
# each workspace package separately.
#
# Stages:
#   base    — node:22-alpine with corepack/pnpm enabled
#   deps    — installs the full monorepo deps (cached on package.json + lockfile)
#   builder — copies source + generates Prisma client (linux-musl binary)
#   deploy  — `pnpm deploy --prod` produces a self-contained /deploy tree
#   runtime — minimal final image: just /deploy + node + tini

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install all workspace deps once. Cached by package.json + lockfile.
# Native modules (argon2) may need build tooling if no prebuilt wheel matches;
# we install + remove it within the same layer to keep the deps image lean.
# ---------------------------------------------------------------------------
FROM base AS deps
# openssl: needed by the Prisma schema/migration engine on Alpine.
# python3/make/g++: fallback build tools if a native module (argon2) has no
# prebuilt wheel for musl.
# libc6-compat: glibc shim some prebuilds expect.
RUN apk add --no-cache openssl python3 make g++ libc6-compat
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/media/package.json packages/media/package.json
COPY e2e/package.json e2e/package.json
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — copy source and generate Prisma client with linux-musl binary.
# We don't tsc-compile the api here: workspace deps export .ts source, and
# runtime uses tsx anyway. `pnpm typecheck` (run in CI/locally) is the real
# typecheck gate.
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @tavern/db generate

# ---------------------------------------------------------------------------
# deploy — pnpm deploy produces a self-contained directory: the api's prod
# deps + the workspace packages it pulls in, with no symlinks back to /app.
# pnpm deploy --prod strips devDeps, which removes the Prisma CLI from the
# tree. The CLI is also what writes the generated .prisma/client output, so
# we re-run `prisma generate` against the deploy schema using the CLI from
# /app (where it's still installed as a devDep).
# ---------------------------------------------------------------------------
FROM builder AS deployer
RUN pnpm --filter @tavern/api --prod deploy /deploy
# Regenerate the Prisma client into the deploy tree. The CLI lives in
# @tavern/db's scoped node_modules (devDep, so pnpm deploy --prod above
# left it out of /deploy). cwd is the deploy root so prisma finds the
# package.json there and doesn't try to auto-install itself.
RUN cd /deploy && /app/packages/db/node_modules/.bin/prisma generate \
    --schema=node_modules/@tavern/db/prisma/schema.prisma

# ---------------------------------------------------------------------------
# runtime — final image, no toolchain. tini reaps zombies and forwards signals.
# argon2 native bindings link against libstdc++.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# libstdc++: argon2 native bindings. openssl: prisma query engine needs
# libssl.so.3 at runtime. tini: PID 1 zombie reaper + signal forwarder.
RUN apk add --no-cache libstdc++ openssl tini
COPY --from=deployer --chown=node:node /deploy ./
USER node
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
# Run tsx via its bin symlink directly. `pnpm exec` re-runs a deps-status
# check that writes a tmp file under /app, which the unprivileged node user
# can't do at runtime.
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "src/index.ts"]
