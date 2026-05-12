# Code Review Session 3 — Progress Report

**Date:** 2026-05-11

## Cumulative state (after Session 3)

| Severity | Closed | Total | Remaining |
|----------|--------|-------|-----------|
| CRITICAL | **17 / 17** ✅ | 17 | 0 |
| HIGH     | **~56 / 57** ✅ | 57 | 1 (DOC-001 deferred to Phase G) |
| MEDIUM   | ~1 / 66 | 66 | ~65 |
| LOW      | 0 / 44 | 44 | 44 |
| **Total**| **~74 / 184** | 184 | ~110 |

Gates throughout: `pnpm typecheck && pnpm lint && pnpm test` — **all green, 60 tests** (46 shared + 14 api).

## Session 3 deliverables — Phase B completion

### B.4 finished (4 remaining HIGH)
- **RT-002** socket backpressure — `sendRaw` checks `ws.bufferedAmount` against a 1 MiB cap and closes slow consumers with code 1009.
- **RT-003** 256-buffer overflow — `Client.bufferFloor` tracks the oldest replayable seq; RESUME with a lower `lastSeq` returns `INVALID_SESSION { reason: 'BUFFER_GAP' }` plus a structured log.
- **RT-005** fanout permission cache — `shouldDeliver` now takes an optional `(channelId,userId) → Promise` cache populated per fanout call; one DB hit per (channel, viewer) regardless of how many events share the channel.
- **RT-009** multi-tab presence — gateway maintains `userId → Set<connectionId>`; on the last close it sweeps lingering `VoiceState.channelId` and emits the `VOICE_STATE_UPDATE` leave broadcasts.

### B.5 — Frontend HIGH (12 fixes)
- **FE-03** AppShell — ref-guarded one-shot auto-navigate so a stale closure can't redirect after the user has navigated.
- **FE-04** VoiceRoom — `reportVoiceState` held in a ref so the join effect always sees the latest channelId-bound function.
- **FE-05** toggleMic — try/catch + toast on failure; UI state only flips after LiveKit acks.
- **FE-06** MessageComposer — recorder + media-stream tracked in refs and stopped on unmount.
- **FE-07** MessageList — sticky scroll-to-bottom only when within 120px of the bottom.
- **FE-08** MessageList — drop the no-op useMemo over messages.
- **FE-09** AttachmentView — distinct `loadError` state instead of sticky "loading…".
- **FE-10** MemberSidebar — explicit loading / error / empty states.
- **FE-11** ReactionBar — toast on PUT/DELETE failures.
- **FE-22** MessageList delete — new `ConfirmDialog` (built on Modal) replaces `window.confirm` + `window.alert`.
- **FE-23** channel sidebar — toast when `/servers/:id/channels` fails.
- **FE-24** MessageComposer — client-side size + MIME validation before presign; rejects SVG outright.
- **FE-25** Mic optimistic update — covered by FE-05 reorder.

New web modules:
- `apps/web/src/lib/toast.ts` — dependency-free Zustand-style toast store + `useToasts()` hook.
- `apps/web/src/components/Toaster.tsx` — mounted in `main.tsx`.
- `apps/web/src/components/ConfirmDialog.tsx` — Modal-based replacement for `confirm()`.

Bonus closed alongside: **FE-14** removed the unused `@tanstack/react-query` boot from `main.tsx`.

### B.6 — Infra / Docs HIGH (13 of 14; DOC-001 deferred)

**B.6.a Compose & Dockerfiles**
- **INF-005** LiveKit single UDP port mode (`udp_port: 7882`) so compose's `7882/udp` is sufficient.
- **INF-006** worker idles when `REDIS_URL` is unset (never-resolving promise) so `restart: on-failure` can't trigger a restart loop on clean exit.
- **INF-007** api + worker `depends_on garage: service_healthy` (was `service_started`).
- **INF-008** api/worker already had `USER node`; verified.
- **INF-013** `scripts/ensure-env.mjs` and `scripts/garage-config.mjs` write secrets with `mode: 0o600`.

**B.6.b Configuration & governance**
- **INF-010** `.env.example` adds `LOG_LEVEL`, commented `WEB_PORT`, `GARAGE_RPC_SECRET`/`ADMIN_TOKEN`/`METRICS_TOKEN`, `AUDIT_RETENTION_DAYS`, `NONCE_RETENTION_HOURS`.
- **INF-011** new `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.
- **INF-009** new `.github/workflows/ci.yml` — Postgres service, install, db migrate, typecheck, lint, test.
- **INF-012** `docs/deployment.md` corrected — Redis is **optional**, required only for multi-replica.

**B.6.c Docs drift**
- **DOC-002** `docs/permissions.md` now has the full bit-position table (decimal values for every flag, with reserved bits called out).
- **DOC-003** `docs/permissions.md` lists the exact `PERMISSION_DEFAULT_EVERYONE` bundle plus notable omissions.
- **DOC-004** `docs/roadmap.md` Phase 0 row brought current.
- **DOC-001** `docs/api.md` regeneration deferred to **Phase G** (docs-sync sweep) — large mechanical pass that benefits from being done after Phase C+D close the routes touched there.

## Files touched this session

API:
- `apps/api/src/app.ts` — CSP/header hook, cookie plugin, ban-route reg
- `apps/api/src/gateway/index.ts` — RT-002 backpressure, RT-003 buffer floor, RT-005 fanout cache, RT-009 multi-tab + voice cleanup
- `apps/api/src/lib/jwt.ts` — SEC-005 audience claim
- `apps/api/src/routes/auth.ts` — cookie set/clear, login 10/min, password-change route
- `apps/api/src/routes/voice.ts` — `/voice/refresh-token`, batched leave, channelId fanout
- `apps/api/src/routes/overwrites.ts` — PERM-003 + PERM-005
- `apps/api/src/routes/uploads.ts` — `sanitizeFilename` hardening
- `apps/api/src/services/auth-service.ts` — lockout decay, session cap, password change
- `apps/api/src/services/gateway-broker.ts` — RedisBroker logging + LazyBroker swap re-attach
- `apps/api/src/services/upload-validator.ts` — UPL-003 MIME-vs-extension hints
- `apps/api/src/services/ban-service.ts` *(new)*
- `apps/api/src/routes/bans.ts` *(new)*
- `apps/api/test/auth.test.ts` — 3 cookie tests

Worker:
- `apps/worker/src/index.ts` — maintenance queue, idle-when-no-redis
- `apps/worker/src/config.ts` — AUDIT_RETENTION_DAYS, NONCE_RETENTION_HOURS

Web:
- `apps/web/src/main.tsx` — Toaster, drop QueryClient
- `apps/web/src/lib/api-client.ts` — memory-only access token, credentials:include
- `apps/web/src/lib/auth.ts` — cookie-aware bootstrap probe
- `apps/web/src/lib/toast.ts` *(new)*
- `apps/web/src/components/Toaster.tsx` *(new)*
- `apps/web/src/components/ConfirmDialog.tsx` *(new)*
- `apps/web/src/components/MessageList.tsx` — sticky scroll, useMemo dropped, Modal delete, error toast
- `apps/web/src/components/MessageComposer.tsx` — recorder cleanup, size/MIME validation, toast errors
- `apps/web/src/components/VoiceRoom.tsx` — ref'd reportVoiceState, mic after LiveKit, error toast
- `apps/web/src/components/AttachmentView.tsx` — loadError state
- `apps/web/src/components/MemberSidebar.tsx` — loading/error/empty
- `apps/web/src/components/ReactionBar.tsx` — error toast
- `apps/web/src/routes/app-shell.tsx` — ref-guarded auto-nav, channel-error toast

Shared:
- `packages/shared/src/errors.ts` — `ROLE_HIERARCHY`, `MEMBER_BANNED`
- `packages/shared/src/schemas/auth.ts` — optional refreshToken, change-password schema
- `packages/shared/src/schemas/bans.ts` *(new)*
- `packages/shared/src/schemas/gateway.ts` — GUILD_BAN_ADD/REMOVE
- `packages/shared/src/schemas/index.ts` — bans export

DB:
- `packages/db/prisma/schema.prisma` — ServerBan, ModerationAction indexes
- `packages/db/prisma/migrations/20260511193000_add_server_bans/`
- `packages/db/prisma/migrations/20260511193500_add_message_trgm/`
- `packages/db/prisma/migrations/20260511194000_add_high_priority_indexes/`

Media:
- `packages/media/src/storage/local.ts` — ticket sweep interval + close()
- `packages/media/src/storage/types.ts` — abstract close() default

Infra / governance:
- `infra/docker/docker-compose.yml` — service_healthy for garage, worker restart:on-failure
- `infra/livekit/livekit.yaml` — single UDP port
- `scripts/ensure-env.mjs` — mode 0o600
- `scripts/garage-config.mjs` — mode 0o600
- `.env.example` — new vars
- `LICENSE` *(new)*, `SECURITY.md` *(new)*, `CONTRIBUTING.md` *(new)*, `CODE_OF_CONDUCT.md` *(new)*
- `.github/workflows/ci.yml` *(new)*

Docs:
- `docs/architecture.md` — pg_trgm note
- `docs/production-hardening.md` — pg_trgm + DB-extensions checklist
- `docs/native-setup.md` — pg_trgm prereq
- `docs/deployment.md` — Redis-optional alignment, broken compose command fixed
- `docs/permissions.md` — full bit table, default-everyone table, role-hierarchy + ban sections
- `docs/roadmap.md` — Phase 0 current

## Remaining

| Phase | Count | What's there |
|-------|-------|--------------|
| C — MEDIUM | ~65 | 7 themed sweeps: logging, security defense-in-depth, perm/upload polish, DB tuning, realtime polish, frontend cleanup, infra/doc polish |
| D — LOW | 44 | 4 batches: style+copy, schema timestamps + FK indexes, realtime polish, misc |
| E — Integration tests | — | testcontainers harness + ~10 test files, target 80% statement coverage on `apps/api` |
| F — E2E + walkthrough | — | extend walkthrough with new flows, re-record |
| G — Docs sync + final gate | — | regenerate `docs/api.md` (DOC-001), final 6-command gate, write `SUMMARY.md` |

Estimated 5 more sessions to complete.
