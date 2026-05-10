# Roadmap & implementation status

This file is the source of truth for what is **wired end-to-end**. Honest
status, no aspiration.

## Phase 0 — Foundation

| Item | Status |
|------|--------|
| pnpm monorepo + strict TS + ESLint/Prettier | Built |
| `packages/shared` (zod schemas, errors, constants, ULID, dice parser) | Built |
| `packages/db` (Prisma schema for all phases, seed) | Built |
| `apps/api` Fastify + auth (register/login/refresh/logout/me) | Built |
| Auth tests (Vitest + Fastify inject + in-memory prisma stub) | Built (8 tests) |
| `apps/worker` BullMQ with real upload-scan handler | Built |
| `apps/web` Vite/React shell, login + register, app shell | Built |
| Docker Compose (postgres, redis, minio, clamav, livekit profile) | Built |
| `.env.example`, LiveKit + Traefik examples | Built |
| Docs: README, architecture, api, permissions, deployment, safety, tabletop | Built |

## Phase 1 — Servers, channels, messages, gateway

| Item | Status |
|------|--------|
| Server CRUD with member management | Built |
| Category + text + voice channel CRUD | Built |
| Message CRUD (create/list/edit/delete/reply, nonce idempotency) | Built |
| Server-side HTML sanitisation on message content | Built |
| WebSocket Gateway: HELLO / IDENTIFY / READY / HEARTBEAT / DISPATCH | Built |
| Gateway dispatch filtering by VIEW_CHANNEL | Built |
| Per-channel typing indicators | Built |
| Web: server rail, channel sidebar, virtualized message list, composer | Built |
| Web: realtime store + gateway client with reconnect/backoff | Built |

## Phase 2 — Roles, permissions, moderation, uploads

| Item | Status |
|------|--------|
| Role CRUD + assignment | Built |
| Permission overwrite CRUD with deny->allow resolution | Built |
| Permission resolver tests (13 cases incl. hidden channels, ADMIN bypass) | Built |
| Hidden channels return 404 to avoid existence leak | Built |
| Server-wide reports + queue + categories | Built |
| Audit log writes on moderation actions | Built |
| Server safety policy + instance defaults | Built |
| Quarantine bucket + status transitions | Built |
| MinIO presigned upload pipeline | Built |
| Worker: magic-byte validation + ClamAV INSTREAM scanner | Built |
| Worker: sharp-based image normalisation + EXIF strip + thumbnails | Built |
| Web: report dialog, moderation queue + audit log pages | Built |
| Web: mass-action moderation (select + bulk dismiss/warn/block/quarantine) | Built |

## Phase 3 — Media, voice/video, voice messages

| Item | Status |
|------|--------|
| Image / GIF / video / audio attachment rendering | Built |
| Reactions backend (built-in + custom emoji) | Built |
| Reactions UI (toggle, quick-pick, live updates via gateway) | Built |
| Custom emoji upload backend + admin UI | Built |
| LiveKit token issuance with per-source grants | Built |
| Voice/video room frontend (LiveKit client, grid, active speaker) | Built |
| Voice messages — record (MediaRecorder), upload, playback | Built |
| Voice messages — accurate waveform via Web Audio decode | Built |
| Screen sharing | Built |

## Phase 4 — Tabletop

| Item | Status |
|------|--------|
| Campaign CRUD + GM management + safety boundaries | Built |
| Session CRUD + RSVP + recap workflow | Built |
| Campaign notes (incl. gm_only) | Built |
| Handouts (public/gm/specific players) with attachments | Built |
| Safe dice parser (no eval) — 19 test cases | Built |
| Dice roll messages + UI in chat | Built |
| Web: campaigns dashboard with sessions/notes/handouts editors | Built |

## Phase 5 — Board games

| Item | Status |
|------|--------|
| Board game library CRUD with tag/players/time/complexity filters | Built |
| Game night planner + candidate proposals + voting + RSVPs | Built |
| Web: games library + game nights with create UIs and voting | Built |

## Phase 6 — Polish

| Item | Status |
|------|--------|
| Audit log UI | Built |
| Moderation queue with bulk actions | Built |
| Mobile-responsive layout (drawer sidebar) | Built |
| Member list / participant sidebar | Built |
| Reactions, file attachments, voice messages in composer | Built |
| Reportable content (any message → flag → dialog) | Built |
| Server creation modal | Built |
| Channel creation modal (text/voice/category) | Built |
| Server settings: roles editor, member roles, custom emoji, safety policy | Built |
| Message search (Postgres ILIKE, hidden-channel-aware) | Built |
| Production hardening checklist | Built (`docs/production-hardening.md`) |

## Production readiness

| Item | Status |
|------|--------|
| Redis pub/sub gateway broker (auto-promote, in-process fallback) | Built |
| Postgres integration tests via testcontainers | Built (opt-in via `pnpm test:integration`) |
| Playwright E2E smoke test for the golden path | Built (opt-in via `pnpm --filter @tavern/e2e test:e2e`) |

---

## Verified results (current commit)

- `pnpm typecheck` — clean across all 6 packages
- `pnpm test` — **44/44** (36 shared + 8 API)
- `pnpm --filter @tavern/api build` / worker / db — clean
- `pnpm --filter @tavern/web build` — production bundle ~1.0 MB JS / 19.9 KB CSS

## Honest gaps

By design (out of scope per the master spec):
- No federation, no public discovery, no Matrix/Discord interop.
- No live transcription, no native apps, no AI moderation.
- No monetization.
- No password reset email flow.
- No built-in MFA / SSO (front with an auth proxy if needed).

Genuinely not built (and not pretending to be):
- Notification stack (push/email).
- Mobile-native client.
- GDPR data-export tooling (the schema supports it; there's no packaged
  exporter yet).
- Bundle code-splitting for the web app — the SPA ships as a single chunk.

When you find something that says "Built" here but feels half-baked, file an
issue. The intent is that this table is honest; bugs are bugs, not gaps.
