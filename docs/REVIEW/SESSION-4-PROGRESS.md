# Code Review Session 4 — Progress Report

**Date:** 2026-05-11

## Cumulative state (after Session 4)

| Severity | Closed (incl. doc-only) | Remaining | Notes |
|----------|------------------------:|----------:|-------|
| CRITICAL | **17 / 17** ✅ | 0 | All closed in Sessions 1–2. |
| HIGH     | **~56 / 57** | 1 | DOC-001 api.md regen deferred to Phase G. |
| MEDIUM   | **~60 / 66** | ~6 | Bigger refactors (FE-17 worker-poll-replacement, DB-014 deadlock, doc rewrites) deferred to Phase G. |
| LOW      | **~38 / 44** | ~6 | DB-029 TIMESTAMPTZ deferred (separate migration); 5 docs polish folded into Phase G. |
| **Total**| **~170 / 184** | ~14 | Phase E/F/G still pending. |

Gates throughout: `pnpm typecheck && pnpm lint && pnpm test` — **green, 60 tests passing**.

## Session 4 deliverables — Phase C + Phase D

### Phase C — MEDIUM (7 themed sweeps)

**C.1 Structured logging.** `apps/api/src/lib/passwords.ts` no longer uses `console.error`; `setPasswordLogger` is wired to `app.log.warn` at startup so argon2 engine failures land in Pino's structured stream (SEC-011). The gateway-broker default-fallback loggers stay as `console.warn` only because they are no-op fallbacks that real callers immediately override via `initRedisBroker(url, log)`.

**C.2 Security defense-in-depth.** New `TRUST_PROXY` env var with NODE_ENV-aware default (SEC-017). New `LOG_LEVEL` schema entry (SEC-013). nginx now ships `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` (SEC-025). HSTS + CSP are owned by Traefik in production; the nginx file documents how to take them over when run as the edge (SEC-016). The Traefik example now wires every Tavern router through a `tavern-security-headers` middleware (INF-014).

**C.3 Permission / Upload polish.** `attachments.ts` strips the storage-key path from `Content-Disposition` so the on-disk layout isn't leaked (STO-004). `config.ts` refuses to start in production with `ALLOW_UNSCANNED_UPLOADS=true` *and* no `CLAMAV_HOST` configured (UPL-007). BullMQ already used `jobId: scan:${attachmentId}` for scan-job idempotency (UPL-005, verified).

**C.4 Database MEDIUM.** New migration `add_medium_indexes_and_tuning` adds partial index on active sessions, FK indexes on Channel.campaignId / gameNightId / HandoutVisibleUser / CampaignNote / Handout / DiceRoll, and a compound `(channelId, id)` index on Message for paged reads (DB-015..019, DB-021). Bootstrap transaction now runs at `Serializable` isolation (DB-013). DB-023 connection-pool sizing rule added to `production-hardening.md`.

**C.5 Realtime MEDIUM.** Heartbeat sweeper covers pre-identified clients (RT-011). RESUME replays the buffered events when `lastSeq` is within the buffer's window (RT-010) — the previous behaviour always re-READYed.

**C.6 Frontend MEDIUM.** `SearchPage` cancels in-flight requests on rapid re-typing via `AbortController` (FE-15). `AppHome` empty-state copy now says "Pull up a chair" instead of the Phase-0 scaffolding text (FE-20). `router.tsx` route-splits the four heavy pages (`campaigns-page`, `games-page`, `moderation-page`, `server-settings-page`) via `React.lazy` + `Suspense` (FE-21).

**C.7 Infra / Docs MEDIUM.** nginx gzip enabled for text-y assets (INF-015). `ensure-env.mjs` asserts the generated JWT secret is ≥ 32 chars (INF-018). `garage-bootstrap.mjs` reads `GARAGE_HEALTH_TIMEOUT_MS` (INF-019). `deployment.md` "sticky-ish" line corrected — gateway does NOT require sticky sessions (DOC-005). `docker-setup.md` adds the `service_started` vs `service_healthy` note (DOC-006). `README.md` `docker:up:all` description fixed (DOC-010).

### Phase D — LOW (4 batches)

**D.1 Frontend style + voice/copy.** `TavernLogo` SVG back-plate now matches `--bg-canvas` (FE-26). VoiceRoom inline-overlay captions use `bg-overlay/80` instead of `bg-black/40` so the design-system token is consistent (FE-28).

**D.2 Schema FK indexes + cleanup.** New migration `low_polish` drops the redundant non-unique `Invite_code_idx` (DB-024) and adds FK indexes on `BoardGame.ownerUserId`, `GameNight.createdById`, `Report.reporterId`, `CampaignSessionRsvp.userId` (DB-025..028). `schema.prisma` carries a documentation comment about the single-tenant RLS posture (DB-030). TIMESTAMPTZ conversion (DB-029) intentionally deferred to its own future migration.

**D.3 Realtime polish.** Gateway client reconnect backoff adds ±20% jitter so a server restart doesn't cause synchronized thundering-herd retries (RT-015). LiveKit token `nbf` leeway is now a named constant (`LIVEKIT_NBF_LEEWAY_SECONDS`) instead of a magic `5` (VC-010).

**D.4 Misc LOW.** Refresh-token rate limit tightened 60 → 20/min (SEC-020). Startup logs an error if the LiveKit dev secret is still in place in production (SEC-022). New `S3_PRESIGN_EXPIRY_SECONDS` env var (STO-005). Magic-byte sniff fails closed for declared image/video/audio MIMEs that don't match any known signature (UPL-009). Role `position` now capped at 65535 in shared schemas (PERM-012).

## Files touched this session

API:
- `apps/api/src/app.ts` — password-logger wiring, headers hook, LiveKit dev-secret warning, TRUST_PROXY plumbing
- `apps/api/src/config.ts` — TRUST_PROXY, LOG_LEVEL, S3_PRESIGN_EXPIRY_SECONDS env, UPL-007 cross-field validation
- `apps/api/src/gateway/index.ts` — heartbeat covers pre-identified, RESUME buffer replay
- `apps/api/src/lib/jwt.ts` — (no change this session)
- `apps/api/src/lib/passwords.ts` — `setPasswordLogger` injection point
- `apps/api/src/routes/attachments.ts` — Content-Disposition strips path
- `apps/api/src/routes/auth.ts` — refresh rate-limit 20/min
- `apps/api/src/services/auth-service.ts` — bootstrap Serializable isolation
- `apps/api/src/services/livekit-token.ts` — named nbf-leeway constant

Web:
- `apps/web/src/components/TavernLogo.tsx` — back-plate matches `--bg-canvas`
- `apps/web/src/components/VoiceRoom.tsx` — overlay token consistency
- `apps/web/src/lib/gateway-client.ts` — reconnect jitter
- `apps/web/src/router.tsx` — lazy heavy pages
- `apps/web/src/routes/app-home.tsx` — voice/copy refresh
- `apps/web/src/routes/search-page.tsx` — AbortController on debounced search

Worker / shared / db / media:
- `packages/db/prisma/schema.prisma` — Message `@@index([channelId, id])`, RLS doc, ModerationAction indexes (from B)
- `packages/db/prisma/migrations/20260511195000_medium_indexes_and_tuning/migration.sql` *(new)*
- `packages/db/prisma/migrations/20260511195500_low_polish/migration.sql` *(new)*
- `packages/media/src/pipeline.ts` — magic-byte fail-closed for media MIMEs
- `packages/shared/src/schemas/roles.ts` — `MAX_ROLE_POSITION` cap

Infra / scripts / docs:
- `apps/web/nginx.conf` — gzip block, Permissions-Policy
- `infra/traefik/dynamic.yml` — security-headers middleware
- `scripts/ensure-env.mjs` — JWT length assertion
- `scripts/garage-bootstrap.mjs` — `GARAGE_HEALTH_TIMEOUT_MS`
- `docs/deployment.md` — sticky-session correction
- `docs/docker-setup.md` — service_healthy note
- `docs/production-hardening.md` — connection-pool sizing
- `README.md` — `docker:up:all` description

## Remaining (E / F / G)

| Phase | Effort | Output |
|-------|--------|--------|
| E — Integration test backfill | 1–2 sessions | testcontainers harness + ~10 test files; target 80% statement coverage on `apps/api/src/{routes,services,lib}` |
| F — E2E + walkthrough refresh | 0.5 session | Extend `walkthrough.spec.ts` with bootstrap, ban, attachment, screen-share, search; regenerate artefact |
| G — Docs sync + final gate + SUMMARY.md | 0.5–1 session | Regenerate `docs/api.md` (DOC-001 + every endpoint added in A/B/C/D); run six-command gate; write `docs/REVIEW/SUMMARY.md` mapping every finding ID to its fix commit |

After Phase G the engagement is complete: every CRITICAL/HIGH closed, MEDIUM/LOW either fixed or documented as deferred with rationale, integration coverage at the agreed target, and a single SUMMARY index for the whole review.
