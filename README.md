# Tavern

> A cozy hall for friends, gaming groups, and tabletop crews.

Tavern is a **self-hosted, web-first, Discord-shaped** community app for small
private communities, tabletop RPG groups, and board gamers. It runs entirely on
infrastructure you control. There are no paid AI dependencies and no external
moderation services — Tavern ships with a **local Trust & Safety Core** for
access control, upload hygiene, reporting, quarantine, audit logs, and
configurable community policies.

This is **not** a Discord clone or Matrix bridge. There is no public server
discovery and no monetization. Live transcription is not built in. Tavern
supports **opt-in federation** with other Tavern instances over a small,
documented protocol (IR20) — off by default, controlled by `FEDERATION_ENABLED`,
and limited to the capabilities each side advertises. See
[`docs/federation.md`](docs/federation.md) for the design and the operator
guide for how to keep it disabled if you want a fully-private instance.

---

## What's in this repository

```
apps/
  api/          Fastify HTTP + WebSocket gateway
  worker/       BullMQ background workers (uploads, scanning, media)
  web/          Vite + React + TanStack Router frontend
packages/
  shared/       zod schemas, permission bitset, dice parser, ULID, errors
  db/           Prisma schema + client + seed
infra/
  docker/       docker-compose for postgres, redis, garage, clamav, livekit
  garage/       Garage S3-compatible storage config + bootstrap helper
  livekit/      example LiveKit config
  traefik/      example reverse proxy config (production)
docs/
  architecture.md, api.md, permissions.md, deployment.md,
  tabletop.md, safety.md, roadmap.md
```

## Quick start (no Docker)

Prerequisites:

- **Node 22+** (`node --version`)
- **pnpm 9+** (`corepack enable && corepack use pnpm@9`)
- **PostgreSQL 16+** running locally (any install)

That's it. Redis, object storage (Garage / any S3), ClamAV, and LiveKit are all optional — Tavern uses
in-process / on-disk fallbacks when they're missing. See
[`docs/native-setup.md`](docs/native-setup.md) for OS-specific Postgres
install instructions and how to enable the optional services.

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Copy env. Edit JWT_ACCESS_SECRET / JWT_REFRESH_SECRET (48 hex chars each).
#    Generate strong secrets: openssl rand -hex 48
cp .env.example .env

# 3. Create the database role + database. With Postgres running locally:
psql -U postgres -c "CREATE ROLE tavern WITH LOGIN PASSWORD 'tavern-dev';"
psql -U postgres -c "CREATE DATABASE tavern OWNER tavern;"

# 4. Generate the Prisma client + apply the database schema
pnpm db:generate
pnpm db:migrate
pnpm db:seed     # creates admin user + DEV-INVITE invite code

# 5. Start the API, worker, and web app in parallel
pnpm dev
```

Then open <http://localhost:3030>. Register with the seeded `DEV-INVITE` code,
or log in as `admin` / `change-me-in-dev`.

(Want a different port? `WEB_PORT=3000 pnpm dev`. Update `ALLOWED_ORIGINS` in
`.env` to match.)

When you start the API you'll see a config summary like:

```
tavern config:
  storage:  local (./data/storage)
  redis:    in-process (single-replica only)
  clamav:   disabled (allowUnscanned=true)
  livekit:  disabled (voice/video routes return 503)
```

That confirms you're running in zero-Docker mode. Voice/video tries to
load LiveKit and gets a friendly 503 — everything else (chat, dice, files,
campaigns, board games, moderation, search) works.

### Prefer Docker?

Two container modes:

- `pnpm docker:up` — infra only (postgres + redis + garage + clamav).
  Pair with `pnpm dev` on the host for fast iteration. The script chains
  `pnpm garage:bootstrap` automatically, so the dev S3 key + buckets are
  ready on first boot (idempotent on subsequent boots).
- `pnpm docker:up:all` — same as `docker:up` **plus** the LiveKit
  voice/video server. DOC-010.
- `pnpm docker:up:full` — same infra **plus** api + worker + web in
  containers, with migrations applied automatically. Open
  <http://localhost:3030>. This is the production-shaped path; nginx
  serves the web build and proxies `/api/*` + `/gateway` to the api so
  the browser only sees one origin.

See [`docs/docker-setup.md`](docs/docker-setup.md) for the full picture
and apps-mode env overrides.

## Status

All six phases of the master spec are built and tested:

| Phase | Scope | Status |
|------:|-------|--------|
| 0 | Monorepo, Prisma schema, auth, dev infra, docs | Built |
| 1 | Servers/channels/messages REST + WebSocket gateway + typing | Built |
| 2 | Roles, overwrites, moderation queue + bulk actions, uploads + ClamAV | Built |
| 3 | Media embeds, reactions, custom emoji, voice/video rooms, screen share, voice messages | Built |
| 4 | Campaigns, sessions, dice, notes, handouts (with attachments) | Built |
| 5 | Board games, game nights, voting, RSVPs | Built |
| 6 | Polish: settings UI, search, mass-action mod, mobile, hardening doc | Built |

Production-grade additions:

- Redis pub/sub gateway broker (auto-promotes from in-process; fallback if
  Redis is unreachable)
- Postgres integration tests via testcontainers (opt-in)
- Playwright E2E smoke test (opt-in)

See [`docs/roadmap.md`](docs/roadmap.md) for a feature-by-feature breakdown
and [`docs/production-hardening.md`](docs/production-hardening.md) for the
self-host production checklist.

## Trust & safety, honestly stated

Tavern includes built-in local trust and safety tooling for access control,
upload hygiene, reporting, quarantine, audit logs, and configurable community
policies. Tavern **does not** claim to automatically detect all illegal content,
nor does it use any AI moderation provider. Operators are responsible for
configuring policies appropriate to their jurisdiction and community. See
[`docs/safety.md`](docs/safety.md).

## License

MIT.
