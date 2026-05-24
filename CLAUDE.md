# CLAUDE.md — Tavern

Project conventions for any agent working in this repo. Keep terse. Read once, refer back.

## What this is

Tavern is a self-hosted, web-first, Discord-shaped community app for small private communities, tabletop RPG groups, and board gamers. Self-hosted with opt-in federation (Phases 1-6: peering + remote-user identity + federated channel messages/edits/deletes/reactions + federated invites and Tavern mirroring + federated 1:1 DMs (gated on the `dms` capability) + federated presence and custom status (gated on the `presence` capability + `FEDERATION_PRESENCE_ENABLED`) via `FEDERATION_ENABLED`, off by default — voice still local). No public discovery, no monetization, no paid AI dependencies. A local Trust & Safety Core handles moderation.

## Layout

```
apps/
  api/       Fastify HTTP + WebSocket gateway
  worker/    BullMQ background workers (uploads, scanning, media)
  web/       Vite + React + TanStack Router frontend
packages/
  shared/    zod schemas, permission bitset, dice parser, ULID, errors
  db/        Prisma schema + client + seed
  media/     LiveKit + media helpers
  federation/ Ed25519 + canonical-JSON + envelope signing + SSRF guard + at-rest encryption
infra/       docker-compose, livekit, traefik configs
docs/        Architecture, API, deployment, design system, etc.
e2e/         Playwright suite + walkthrough scripts
```

## Stack

- **Node 22+, pnpm 9+** (corepack)
- **PostgreSQL 16+** required. Redis, object storage (Garage / any S3-compatible), ClamAV, LiveKit are optional — Tavern uses in-process / on-disk fallbacks when missing.
- Web: Vite + React + TanStack Router + Tailwind + Radix primitives + Lucide icons
- API: Fastify with WebSocket gateway
- Worker: BullMQ
- DB: Prisma against Postgres

## Dev commands

```bash
pnpm install                  # install workspace deps
pnpm db:generate              # prisma generate
pnpm db:migrate               # apply schema
pnpm db:seed                  # seed admin / change-me-in-dev + DEV-INVITE code
pnpm dev                      # api + worker + web in parallel (web on :3030)
pnpm typecheck                # all workspaces
pnpm lint                     # all workspaces
pnpm test                     # all unit tests
pnpm test:integration         # api integration suite
pnpm test:e2e                 # playwright
pnpm walkthrough              # full app video tour (E2E + assemble)
pnpm build                    # all workspaces
```

Web defaults to `http://localhost:3030`. Override with `WEB_PORT=3000 pnpm dev` (also update `ALLOWED_ORIGINS` in `.env`).

## UI work — read this first

**Before touching anything in `apps/web`**, open [`docs/design-system.html`](docs/design-system.html). It's the source of truth for surfaces, tokens, type, motion, sound, voice, and the per-component patterns.

Hard rules:

- **Use the semantic tokens.** Tailwind utilities like `bg-canvas`, `bg-sunken`, `bg-surface`, `text-fg`, `text-fg-muted`, `border-subtle`, `bg-ember`, `bg-tint-ember`. The old `tavern-*` classes were removed in the design-system migration — they no longer resolve. ESLint will block any reintroduction.
- **Use the named transitions and durations.** `--t-base` + `--ease-decel` for enter; `--t-base` + `--ease-accel` for exit. See the Motion section.
- **Reach for existing components and atoms** — `Modal`, `Field`, `TextInput`, `PrimaryButton`, `GhostButton`, `ErrorAlert` from `apps/web/src/components/Modal.tsx`. Don't invent new chrome unless the inventory genuinely doesn't cover the case.
- **Stay in voice.** Tavern, room, member, "pull up a chair" — never "channel" / "server" / "join" in user-facing copy. See the Voice & copy section of the design doc.
- **Sentence case for headings, labels, buttons. Always.**

## Other docs

`docs/architecture.md` · `docs/api.md` · `docs/permissions.md` · `docs/deployment.md` · `docs/native-setup.md` · `docs/docker-setup.md` · `docs/production-hardening.md` · `docs/safety.md` · `docs/tabletop.md` · `docs/walkthrough.md` · `docs/roadmap.md` · `docs/federation.md` · `docs/federation-operations.md` · `docs/federation-followups.md`

## Workflow

1. Map the request to a surface — most things have a section in the design doc.
2. Use existing components and tokens.
3. Run `pnpm typecheck && pnpm lint` before declaring done.
4. For UI changes, run `pnpm dev` and exercise the affected flow in a browser.
