# Roadmap & implementation status

This file is the source of truth for what is **wired end-to-end** vs what
needs further work. Honest status, no aspiration.

## Phase 0 — Foundation

| Item | Status |
|------|--------|
| pnpm monorepo + strict TS + ESLint/Prettier | Built |
| `packages/shared` (zod schemas, errors, constants, ULID, dice parser) | Built |
| `packages/db` (Prisma schema for all phases, seed) | Built |
| `apps/api` Fastify scaffold + auth (register/login/refresh/logout/me) | Built |
| Auth tests (Vitest + Fastify inject + in-memory prisma stub) | Built (8 tests) |
| `apps/worker` BullMQ queues with real upload-scan handler | Built |
| `apps/web` Vite/React shell, login + register, app shell | Built |
| Docker Compose (postgres, redis, minio, clamav, livekit profile) | Built |
| `.env.example`, LiveKit config, Traefik examples | Built |
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
| Web: server rail, channel sidebar, virtualized message list, composer | Built |
| Web: realtime store + gateway client with reconnect/backoff | Built |
| Per-channel typing indicators | Not built |

## Phase 2 — Roles, permissions, moderation, uploads

| Item | Status |
|------|--------|
| Role CRUD + assignment | Built |
| Permission overwrite CRUD with deny->allow resolution | Built |
| Permission resolver tests (13 cases incl. hidden channels, ADMIN bypass) | Built |
| Hidden channels return 404 (not 403) to avoid existence leak | Built |
| Server-wide reports + queue + categories | Built |
| Audit log writes on moderation actions | Built |
| Server safety policy + instance defaults | Built |
| Quarantine bucket + status transitions | Built |
| MinIO presigned upload pipeline | Built |
| Worker: magic-byte validation + ClamAV INSTREAM scanner | Built |
| Worker: sharp-based image normalisation + EXIF strip + thumbnails | Built |
| Web: report dialog, moderation queue + audit log pages | Built |

## Phase 3 — Media, voice/video, voice messages

| Item | Status |
|------|--------|
| Image / GIF / video / audio attachment rendering | Built |
| Reactions backend (built-in + custom emoji) | Built |
| Reactions UI (toggle, quick-pick, live updates via gateway) | Built |
| Custom emoji upload (backend) | Built (admin UI not yet) |
| LiveKit token issuance | Built |
| Voice/video room frontend (LiveKit client, grid, active speaker) | Built |
| Voice messages — record (MediaRecorder), upload, playback | Built |
| Voice messages — accurate waveform | Placeholder; ffmpeg-based peak generation TODO |
| Optional screen sharing | Token grants `screen_share`; explicit UI button TODO |

## Phase 4 — Tabletop

| Item | Status |
|------|--------|
| Campaign CRUD + GM management | Built |
| Session CRUD + RSVP | Built |
| Campaign notes (incl. gm_only) | Built |
| Handouts (public/gm/specific players) | Built |
| Safe dice parser (no eval) — 19 test cases | Built |
| Dice roll messages + UI in chat | Built |
| Web: campaigns dashboard with sessions + safety boundaries | Built |
| Web: notes/handouts editor UI | Backend ready; full editor TODO |
| Session recap workflow | Endpoint exists; dedicated UI TODO |

## Phase 5 — Board games

| Item | Status |
|------|--------|
| Board game library CRUD with tag/players/time/complexity filters | Built |
| Game night planner + candidate proposals + voting + RSVPs | Built |
| Web: games library + game nights page | Built (read-only; create UI TODO) |

## Phase 6 — Polish

| Item | Status |
|------|--------|
| Audit log UI | Built |
| Moderation queue UI with one-click resolve actions | Built |
| Mobile-responsive layout (drawer sidebar on small screens) | Built |
| Member list / participant sidebar | Built |
| Reactions, file attachments, voice messages in composer | Built |
| Reportable content (any message -> flag -> dialog) | Built |
| Final docs pass | Built |
| Production hardening checklist | TODO |
| Server creation UI | Endpoint ready; UI TODO |
| Channel/role management UI | Endpoints ready; UI TODO |

---

## Verified results

- `pnpm typecheck` — clean across all 5 packages
- `pnpm test` — **44/44 passing** (36 shared + 8 API)
- `pnpm --filter @tavern/web build` — production bundle ~956 KB JS / 18.9 KB CSS

## Honest gaps

By design (out of scope per the master spec):
- No federation, no public discovery, no Matrix/Discord interop.
- No live transcription, no native apps, no AI moderation.
- No monetization.

Not yet built but spec-aligned:
- Mass-action UI for moderation queue.
- Notification stack (push/email).
- Search across messages/attachments.
- Mobile-native client.
- Proper waveform generation for voice messages (ffmpeg-based).
- Cross-process gateway (currently in-process EventEmitter; production needs
  Redis pub/sub).
- Postgres-backed integration tests against testcontainers.
- Playwright E2E coverage.
- "Create server/role/channel" admin UIs — the endpoints exist; the UI lets
  you exercise the authenticated chat/voice/dice/games/moderation flows but
  asks you to use the API directly for org-shape mutations.

When an item says "TODO":

- The schema is in place.
- The shape of the API is consistent with the rest of the system.
- The UI may show empty states or directs you to the relevant endpoint.
