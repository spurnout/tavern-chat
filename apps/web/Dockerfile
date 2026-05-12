# syntax=docker/dockerfile:1.7
#
# Tavern Web image — Vite/React production build served by nginx-alpine.
#
# Build context: the workspace root.
#
#   docker build -f apps/web/Dockerfile -t tavern-web .
#
# Stages:
#   base    — node:22-alpine for the build phase (corepack + pnpm)
#   deps    — installs workspace deps with the lockfile (cache-friendly)
#   builder — `vite build` -> dist/ static files
#   runtime — nginx:alpine serving the static build with SPA fallback

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
WORKDIR /app

FROM base AS deps
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

FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @tavern/web build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's default CMD already runs nginx -g 'daemon off;'
