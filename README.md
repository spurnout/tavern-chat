# Tavern

> A cozy hall for friends, gaming groups, and tabletop crews.

Tavern is a **self-hosted, web-first, Discord-shaped** community app for small
private communities, tabletop RPG groups, and board gamers. It runs entirely on
infrastructure you control. There are no paid AI dependencies and no external
moderation services — Tavern ships with a **local Trust & Safety Core** for
access control, upload hygiene, reporting, quarantine, audit logs, and
configurable community policies.

This is **not** a Discord clone or Matrix bridge. It does not federate. It does
not have public server discovery, monetization, or live transcription.

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
  docker/       docker-compose for postgres, redis, minio, clamav, livekit
  livekit/      example LiveKit config
  traefik/      example reverse proxy config (production)
docs/
  architecture.md, api.md, permissions.md, deployment.md,
  tabletop.md, safety.md, roadmap.md
```

## Quick start

Prerequisites:

- **Node 22+** (`node --version`)
- **pnpm 9+** (`corepack enable && corepack use pnpm@9`)
- **Docker** + **Docker Compose v2**

```bash
# 1. Install workspace dependencies
pnpm install

# 2. Copy env, then edit JWT secrets at minimum
cp .env.example .env

# 3. Start infrastructure (postgres, redis, minio, clamav)
pnpm docker:up

# 4. Apply the database schema
pnpm db:migrate
pnpm db:seed     # creates admin user + DEV-INVITE invite code

# 5. Start the API, worker, and web app in parallel
pnpm dev
```

Then open <http://localhost:3000>. Register with the seeded `DEV-INVITE` code,
or log in as `admin` / `change-me-in-dev`.

## Phase status

| Phase | Scope | Status |
|------:|-------|--------|
| 0 | Monorepo, Prisma schema, auth, dev infra, docs | **Built** |
| 1 | Servers/channels/messages REST + WebSocket gateway | Built (see `docs/roadmap.md`) |
| 2 | Roles, permission overwrites, moderation, uploads + ClamAV | Built |
| 3 | Media embeds, reactions, voice/video rooms, voice messages | Built |
| 4 | Campaigns, sessions, dice rolling, notes, handouts | Built |
| 5 | Board game library, game nights, voting | Built |
| 6 | Polish, audit logs UI, responsiveness | In progress |

See [`docs/roadmap.md`](docs/roadmap.md) for a feature-by-feature breakdown of
what's wired end-to-end vs what's scaffolded for later iteration.

## Trust & safety, honestly stated

Tavern includes built-in local trust and safety tooling for access control,
upload hygiene, reporting, quarantine, audit logs, and configurable community
policies. Tavern **does not** claim to automatically detect all illegal content,
nor does it use any AI moderation provider. Operators are responsible for
configuring policies appropriate to their jurisdiction and community. See
[`docs/safety.md`](docs/safety.md).

## License

MIT.
