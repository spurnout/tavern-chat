# Code Review Session 2 — Progress Report

**Date:** 2026-05-11

## Cumulative state (after Session 2)

| Severity | Closed | Total | Remaining |
|----------|--------|-------|-----------|
| CRITICAL | **17 / 17** ✅ | 17 | 0 |
| HIGH     | ~22 / 57 | 57 | ~35 |
| MEDIUM   | 1 (bonus SEC-018) / 66 | 66 | ~65 |
| LOW      | 0 / 44 | 44 | 44 |
| **Total**| **40 / 184** | 184 | 144 |

Gates: `pnpm typecheck && pnpm lint && pnpm test` — all green throughout. **60 tests passing** (46 shared + 14 api).

## Session 2 deliverables

### Phase A — last 3 CRITICAL findings closed

**A.1 — SEC-001 / FE-02: cookie-based refresh token**
- Registered `@fastify/cookie` in `apps/api/src/app.ts`.
- `apps/api/src/routes/auth.ts` issues a `tv_refresh` httpOnly+Secure+SameSite=Strict cookie on every auth response; `/refresh` reads it first, body fallback for one deprecation release; `/logout` clears it.
- `apps/web/src/lib/api-client.ts` TokenStore now holds the access token in memory only, expiry in `sessionStorage`. `credentials: 'include'` on every fetch.
- 3 new tests in `apps/api/test/auth.test.ts` cover the Set-Cookie shape and cookie-only refresh flow.

**A.2 — PERM-002: BAN_MEMBERS implemented**
- New `ServerBan` Prisma model + migration `20260511193000_add_server_bans`.
- New `apps/api/src/services/ban-service.ts` — `banMember`, `unbanMember`, `isBanned`, `listBans`, `activeBanServerIds`. Enforces role hierarchy and protects the server owner.
- New `apps/api/src/routes/bans.ts` — `GET/POST/DELETE /api/servers/:serverId/bans`, all gated by `BAN_MEMBERS`.
- `apps/api/src/gateway/index.ts` filters banned servers out of READY and force-closes the banned user's WebSocket on `GUILD_BAN_ADD`.
- New shared schemas + dispatch event names `GUILD_BAN_ADD` / `GUILD_BAN_REMOVE`.

**A.3 — DB-003: `pg_trgm` GIN index for message search**
- Migration `20260511193500_add_message_trgm` enables the extension and creates a partial GIN index on `Message.content WHERE deletedAt IS NULL`.
- Docs updated in `architecture.md`, `production-hardening.md`, `native-setup.md`.

### Phase B — HIGH findings (4 of 6 sub-phases complete)

**B.1 — Security HIGH** (6 fixes, 1 commit)
- **SEC-005** JWT audience claim — `tavern-api` for access, `tavern-refresh` for refresh; both verified.
- **SEC-006** lockout counter no longer resets to zero at threshold — monotonically increasing until a successful login clears it.
- **SEC-007** login rate limit 20 → 10/min.
- **SEC-008** CSP + `x-content-type-options: nosniff` + `referrer-policy: no-referrer` on every API response.
- **SEC-009** per-user session cap of 20; `pruneOldestSessions` revokes the oldest beyond the cap.
- **SEC-010** cookie token delivery — covered by A.1.

**B.2 — Permissions / Upload / Storage HIGH** (6 fixes, 1 commit)
- **UPL-002** `sanitizeFilename` hardened — NFC normalize, Windows-reserved name (`CON`/`PRN`/`COM*`/`LPT*`) rejection, leading-dot strip, trailing dot/space strip, empty-result fallback.
- **UPL-003** MIME-vs-extension allow-list for `handout`/`file` kinds.
- **UPL-004** S3 presigned PUT already returns content-type + content-length headers; documented + worker `statObject` size verification confirmed.
- **STO-002** `LocalStorageBackend` runs a 60s ticket-eviction sweep; `close()` clears the timer on shutdown.
- **PERM-003** overwrite `allow` bits must be a subset of the actor's effective perms (mirrors `requireRoleHierarchy`).
- **PERM-005** overwrite `targetId` validated against the channel's server (role.serverId match or active member).

**B.3 — DB HIGH index batch + retention** (5 fixes + workers, 1 commit)
- Migration `20260511194000_add_high_priority_indexes` adds:
  - **DB-007** `Session(userId) WHERE revokedAt IS NULL` partial index.
  - **DB-008** indexes on `ModerationAction(reportId)` and `(serverId)`.
  - **DB-010** partial-unique on `Message(channelId, nonce) WHERE nonce IS NOT NULL` plus cover index for the nonce-cleanup sweep.
  - **DB-011** partial index on `Attachment(status) WHERE status IN ('pending','processing')`.
- **DB-009** new BullMQ worker queue `tavern.maintenance` with two repeatable jobs:
  - `audit-retention` — deletes `AuditLogEntry` older than `AUDIT_RETENTION_DAYS` (default 90), daily at 03:00 UTC.
  - `nonce-cleanup` — nulls `Message.nonce` older than `NONCE_RETENTION_HOURS` (default 24), every 15 minutes.

**B.4 — Realtime / Voice HIGH** (5 of 9 fixes done)
- **RT-004** Redis malformed payloads now log `gateway.broker.malformed_payload` with a 200-char preview, instead of silently dropping.
- **RT-006** `LazyBroker.useRedis` re-attaches the in-process EventEmitter's existing listeners onto the new Redis broker — previously every subscription registered before promotion was orphaned (silent Redis-mode blackout in multi-replica deployments).
- **RT-007** `/voice/leave` filters out states that aren't in a channel before iterating, avoiding the stateTimer race where a deferred state POST could try to update a freshly-cleared row.
- **RT-008** `/voice/leave` rate-limited 30/min; per-row update loop replaced with a single `updateMany`.
- **VC-001** New `POST /api/voice/refresh-token` route — re-mints a LiveKit token (re-validates permissions live, so a role demote narrows it) for in-progress sessions; client can call before 1-hour TTL expiry.

**B.4 deferred to next session:**
- RT-002 socket backpressure (await `socket.send` + slow-consumer eviction)
- RT-003 256-buffer overflow → INVALID_SESSION signal on stale RESUME
- RT-005 fanout permission cache (request-scoped, leveraging Phase 1 refactor)
- RT-009 multi-tab voice state on tab close (gateway tracks `userId → Set<connectionId>`)

## Files touched this session

API:
- `apps/api/src/app.ts` — @fastify/cookie, CSP/headers hook, ban route registration
- `apps/api/src/routes/auth.ts` — cookie set/clear, login rate limit, password-change route (carried from session 1)
- `apps/api/src/routes/bans.ts` (new)
- `apps/api/src/routes/voice.ts` — channelId fanout, refresh-token route, batched leave
- `apps/api/src/routes/overwrites.ts` — PERM-003 + PERM-005 enforcement
- `apps/api/src/routes/uploads.ts` — sanitizeFilename hardening
- `apps/api/src/services/auth-service.ts` — lockout decay, session cap, change-password (carried)
- `apps/api/src/services/ban-service.ts` (new)
- `apps/api/src/services/gateway-broker.ts` — RedisBroker structured logging, LazyBroker swap fix
- `apps/api/src/services/upload-validator.ts` — UPL-003 MIME-vs-extension hints
- `apps/api/src/gateway/index.ts` — IDENTIFY ban filter, GUILD_BAN_ADD force-close
- `apps/api/src/lib/jwt.ts` — audience claim
- `apps/api/test/auth.test.ts` — 3 cookie-flow tests

Worker:
- `apps/worker/src/config.ts` — AUDIT_RETENTION_DAYS, NONCE_RETENTION_HOURS env
- `apps/worker/src/index.ts` — `tavern.maintenance` queue + repeatable jobs

Shared:
- `packages/shared/src/schemas/auth.ts` — refreshToken optional, ChangePasswordRequest
- `packages/shared/src/schemas/bans.ts` (new)
- `packages/shared/src/schemas/gateway.ts` — GUILD_BAN_ADD/REMOVE dispatch events
- `packages/shared/src/schemas/index.ts` — export bans

DB:
- `packages/db/prisma/schema.prisma` — ServerBan model + relations, ModerationAction indexes
- `packages/db/prisma/migrations/20260511193000_add_server_bans/migration.sql`
- `packages/db/prisma/migrations/20260511193500_add_message_trgm/migration.sql`
- `packages/db/prisma/migrations/20260511194000_add_high_priority_indexes/migration.sql`

Media:
- `packages/media/src/storage/local.ts` — ticket-eviction interval + `close()`
- `packages/media/src/storage/types.ts` — abstract `close()` no-op default

Web:
- `apps/web/src/lib/api-client.ts` — memory-only access token, credentials:include
- `apps/web/src/lib/auth.ts` — drop refreshToken probe (cookie carries it)
- `apps/web/vite.config.ts` — sourcemap 'hidden' (carried from session 1)

Docs:
- `docs/architecture.md` — pg_trgm note
- `docs/production-hardening.md` — pg_trgm checklist
- `docs/native-setup.md` — pg_trgm prerequisite

## Remaining roadmap (sessions 3+)

Per the plan at `~/.claude/plans/please-plan-a-full-giggly-crystal.md`:

| Phase | Remaining |
|-------|-----------|
| B.4 (cont.) | RT-002 backpressure, RT-003 buffer signal, RT-005 fanout cache, RT-009 multi-tab |
| B.5 Frontend HIGH | 12 fixes (hooks + error UX) |
| B.6 Infra/Docs HIGH | 14 fixes |
| C | 66 MEDIUM findings (7 themed sweeps) |
| D | 44 LOW findings (4 batches) |
| E | Integration test backfill to 80% coverage |
| F | E2E + walkthrough refresh |
| G | Docs sync + final gate + SUMMARY.md |

Estimated 8 more sessions to complete.
