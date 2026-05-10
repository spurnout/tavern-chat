# Roadmap & implementation status

This file is the source of truth for what is **wired end-to-end** vs what is
**scaffolded but not yet implemented**.

## Phase 0 — Foundation

| Item | Status |
|------|--------|
| pnpm monorepo + strict TS + ESLint/Prettier | ✅ Built |
| `packages/shared` (zod schemas, errors, constants, ULID, dice parser) | ✅ Built |
| `packages/db` (Prisma schema for all phases, seed) | ✅ Built |
| `apps/api` Fastify scaffold + auth (register/login/refresh/logout/me) | ✅ Built |
| Auth tests (Vitest + Fastify inject + in-memory prisma stub) | ✅ Built |
| `apps/worker` BullMQ stub queues | ✅ Built (no real handlers yet) |
| `apps/web` Vite/React shell, login + register pages, app-shell scaffold | ✅ Built |
| Docker Compose (postgres, redis, minio, clamav, livekit profile) | ✅ Built |
| `.env.example`, LiveKit config, Traefik examples | ✅ Built |
| Docs: README, architecture, api, permissions, deployment, safety, tabletop | ✅ Built |

## Phase 1 — Servers, channels, messages, gateway

| Item | Status |
|------|--------|
| Server CRUD with member management | ✅ Built |
| Category + text + voice channel CRUD | ✅ Built |
| Message CRUD (create / list / edit / delete / reply) | ✅ Built |
| WebSocket Gateway: HELLO / IDENTIFY / READY / HEARTBEAT / DISPATCH | ✅ Built |
| Gateway dispatch filtering by VIEW_CHANNEL | ✅ Built |
| Web: server rail, channel sidebar, message list, composer | ✅ Built (Phase 0 shell extended) |
| Per-channel typing indicators | ⏳ Phase 1 polish |

## Phase 2 — Roles, permissions, moderation, uploads

| Item | Status |
|------|--------|
| Role CRUD | ✅ Built |
| Permission overwrite CRUD | ✅ Built |
| Server-wide reports + queue | ✅ Built |
| Audit log writes on moderation actions | ✅ Built |
| Server safety policy + instance defaults | ✅ Built |
| Quarantine bucket + immutable audit | ✅ Built |
| MinIO presigned upload pipeline | ✅ Built |
| ClamAV worker job + status transitions | ✅ Built |

## Phase 3 — Media, voice/video, voice messages

| Item | Status |
|------|--------|
| Image / GIF / video embeds (sharp post-processing in worker) | ✅ Built |
| Reactions (built-in + custom emoji) | ✅ Built |
| Custom emoji upload | ✅ Built |
| LiveKit token issuance | ✅ Built |
| Voice/video room frontend (LiveKit client) | ✅ Built (basic grid + active speaker) |
| Voice messages (record, upload, waveform, render) | ✅ Built |
| Optional screen sharing | ⏳ Phase 6 polish |

## Phase 4 — Tabletop

| Item | Status |
|------|--------|
| Campaign CRUD + GM management | ✅ Built |
| Session CRUD + RSVP | ✅ Built |
| Campaign notes (incl. gm_only) | ✅ Built |
| Handouts (public/gm/specific players) | ✅ Built |
| Safe dice parser (no eval) | ✅ Built |
| Dice roll messages + UI | ✅ Built |
| Session recap workflow | ⏳ Phase 6 polish |

## Phase 5 — Board games

| Item | Status |
|------|--------|
| Board game library CRUD | ✅ Built |
| Game night planner | ✅ Built |
| Candidate proposals | ✅ Built |
| Voting | ✅ Built |
| RSVPs | ✅ Built |
| Lightweight filter/recommend (player count, time, complexity) | ✅ Built |

## Phase 6 — Polish

| Item | Status |
|------|--------|
| Audit log UI | ⏳ |
| Responsive layout pass | ⏳ |
| Final docs pass | ⏳ |
| Optimization (virtualized lists, message prefetch) | ⏳ |
| Production hardening checklist | ⏳ |

---

## Honest gaps

- **No federation, no public discovery, no Matrix / Discord interop.** This is
  by design.
- **No live transcription, no native apps, no AI moderation.** This is also
  by design.
- **No mass-action UI for moderation queues.** Single-item resolution only.
  Power users will want this.
- **Notification stack (push/email)** is intentionally not in scope yet.
- **Search** (messages, attachments) is not part of any phase yet — the schema
  is ready but no search index is wired up.
- **Mobile native** is not planned; the web app is responsive but not
  optimized for mobile-first.

When something is `⏳` or marked "scaffolded", expect:

- The schema is in place.
- The shape of the API is consistent with the rest of the system.
- The UI may show empty states or `disabled` buttons.
- Tests are not yet written for the missing slice.
