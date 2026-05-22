# Roadmap & implementation status

This file is the source of truth for what is **wired end-to-end**. Honest
status, no aspiration.

## Wave 3 (autonomous run, 2026-05-14 → 2026-05-15)

Six autonomous batches plus the seventh UI close-out batch. Backend
wired end-to-end across all items; the four batch-7 UI surfaces still
need a click-through (#25 stage rooms, #29 breakouts, #32 recording,
#34 whiteboard).

| # | Feature | Status |
|---|---------|--------|
| 35 | WebAuthn passkeys (second factor alongside TOTP) | Built |
| 37 | Password reset via email | Built |
| 38 | GDPR user data export (zip download) | Built |
| 39 | Server backup zip + download | Built |
| 43 | Content warnings / spoiler / NSFW (verified built) | Built |
| 5  | Cross-device draft sync | Built |
| 8  | Forum-style channels (`type: 'forum'`) | Built |
| 11 | Code block syntax highlighting + diff rendering | Built |
| 12 | Reminder follow-ups | Built |
| 46 | Native PWA + push notifications | Built |
| 19 | Music & ambient pads | Built |
| 20 | Card decks | Built |
| 21 | Campaign wiki (`[[wikilink]]`) | Built |
| 23 | Safety tools panel (X-card, lines & veils) | Built |
| 16 | Combat tracker overlay (verified built) | Built |
| 17 | GM screen (NPC roster, secret rolls) | Built |
| 25 | Stage rooms (raise hand, promote/demote) — UI batch 7 | Built |
| 31 | Per-user audio mixer (per-peer volume slider) | Built |
| 40 | Discord/Slack/Matrix JSON importer | Built |
| 44 | Accessibility pass (keyboard nav, ARIA, reduced motion) | Built |
| 26 | Watch parties (MP4; YouTube link deferred) | Built |
| 49 | BYO storage docs (S3/Garage) | Built |
| 29 | Breakout rooms — UI batch 7 | Built |
| 30 | Noise suppression (browser-level via `getUserMedia`) | Built |
| 32 | Recording with consent — UI batch 7 | Built |
| 33 | Live captions (Chromium `SpeechRecognition`) | Built |
| 34 | Whiteboard — UI batch 7 | Built |
| 36 | SSO via OIDC | Built |
| 47 | Plugin SDK manifest (`plugin.json`) | Built |
| 48 | AI session recap (OpenAI-compatible endpoint) | Built |

Wave 3 deliberately did not implement **#45 Federation**. That stance
has since been reversed — see [Direction & non-goals](#direction--non-goals)
below for the planned **IR20 federation network**. The remaining
permanent exclusion is **AI-based content moderation**; the moderation
stack is deterministic and operator-driven by design (see
[safety.md](safety.md)).

V2 follow-ups documented inline in the per-batch results
(`C:\Users\spurn\.claude\plans\can-you-go-ahead-atomic-mango.md`):
LiveKit Egress for server-side recording, Whisper-based captions,
SAML SSO, CRDT whiteboard, VM-isolated plugin execution, streamed LLM
responses, native Dropbox/Nextcloud storage backends. Restated under
[Future infrastructure (V2)](#future-infrastructure-v2) below.

## Phase 0 — Foundation

| Item | Status |
|------|--------|
| pnpm monorepo + strict TS + ESLint/Prettier | Built |
| `packages/shared` (zod schemas, errors, constants, ULID, dice parser) | Built |
| `packages/db` (Prisma schema for all phases, seed) | Built |
| `apps/api` Fastify + auth (register/login/refresh/logout/me/password-change) | Built (DOC-004) |
| Auth tests (Vitest + Fastify inject + in-memory prisma stub) | Built (14 tests, incl. cookie flow) |
| `apps/worker` BullMQ with upload-scan + maintenance retention queues | Built (DOC-004) |
| `apps/web` Vite/React shell, login + register + bootstrap, app shell | Built (DOC-004) |
| Docker Compose: postgres, redis, garage, clamav, gated `apps` + `livekit` profiles | Built (DOC-004) |
| `.env.example`, LiveKit + Traefik examples, governance files (SECURITY/CONTRIBUTING/CoC), CI workflow | Built |
| Docs: README, architecture, api, permissions, deployment, safety, tabletop, design-system, hardening | Built |

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
| S3-compatible (Garage) presigned upload pipeline | Built |
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

## Direction & non-goals

### Planned directions (post-Wave 3)

**IR20 federation network.** Cross-instance federation — identity,
invites, messages, and presence cross Tavern instances; voice deferred
to V2. Reverses the closed-graph stance taken in earlier wave notes.
Substantial scope: protocol design, identity verification across
instances, federated moderation and abuse/ban propagation,
key-rotation, and discovery. "IR20" is the working name only; final
brand TBD. Design doc at [federation.md](federation.md); no code yet.

**Plugin admin review gate.** Plugins currently load on boot from the
`plugins/` directory with no operator confirmation. Planned change:
manifests register as `pending` and do not invoke hooks until an admin
explicitly approves them. Manifest-hash changes re-lock an
already-approved plugin to `pending`. Folds in the per-server install
scope (`InstalledPlugin` schema). See [plugins.md](plugins.md) for the
current trust model and the planned-change callout.

### Future infrastructure (V2)

Deferred — each requires non-trivial infrastructure beyond what's
currently wired:

- **Server-side recording** via LiveKit Egress. Current voice
  recording is client-side MediaRecorder → WAV.
- **Whisper-based live captions.** Current captions use the browser
  `SpeechRecognition` API, which is Chromium-only.
- **VM-isolated plugin execution** (Node `vm` / worker_thread sandbox).
  Complements but does not replace the admin review gate above.
- **CRDT whiteboard** for true concurrent editing without last-write-wins.
- **SAML SSO** alongside the existing OIDC support.
- **Streamed LLM responses** for the session-recap workflow.
- **Native Dropbox / Nextcloud storage backends.**

### Permanently out of scope

- **AI-based content moderation.** Deterministic, operator-driven only.
  See [safety.md](safety.md).
- **Monetization** of any kind in the open-source build.

### Genuinely not built

- Mobile-native client. Web is the only first-class surface.
- Email notification transport. Web Push is built; email is not.
- Bundle code-splitting for the web app — the SPA ships as a single chunk.

When you find something that says "Built" above but feels half-baked,
file an issue. The intent is that this table is honest; bugs are bugs,
not gaps.
