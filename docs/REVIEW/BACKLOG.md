# Tavern Code Review — Consolidated Backlog

**Generated:** 2026-05-11
**Source reviews:** [security](security.md) · [uploads-permissions](uploads-permissions.md) · [database](database.md) · [realtime](realtime.md) · [frontend](frontend.md) · [infra-docs](infra-docs.md) · [test-coverage](test-coverage.md)

## Totals

| Severity | Count | Notes |
|----------|-------|-------|
| CRITICAL | **17** | Security bypass, data leak, broken-on-arrival paths |
| HIGH     | **57** | Correctness bugs, leaks, hot-path perf, missing critical features |
| MEDIUM   | **66** | UX gaps, dead code, doc drift, defense-in-depth |
| LOW      | **44** | Style, naming, marginal optimizations |
| **Total**| **184** findings across 7 slices |

**Test coverage baseline:** 25% (28 of ~109 production files have any test). Target after Phase 4: 80%.

---

## CRITICAL (17) — fix before any other work

| ID | Slice | File:line | Title |
|----|-------|-----------|-------|
| **SEC-001** | security | `apps/web/src/lib/api-client.ts:24-25` | Refresh token in localStorage → XSS exfil (30-day persistent session) |
| **SEC-002** | security | `apps/api/src/services/auth-service.ts` register path | Invite `uses` counter race — `maxUses:1` invite accepted twice concurrently |
| **SEC-003** | security | (missing route) | No password-change or password-reset endpoint exists |
| **SEC-004** | security | bootstrap-status route | Bootstrap-status endpoint accessible without rate limiting |
| **PERM-001** | uploads-permissions | `apps/api/src/routes/roles.ts:119-166` | `PUT /api/servers/:id/members/:userId/roles` — any MANAGE_ROLES holder can grant ADMINISTRATOR |
| **PERM-002** | uploads-permissions | `packages/db/prisma/schema.prisma` | BAN_MEMBERS bit exists but no `ServerBan` model, no enforcement, no ban route |
| **UPL-001** | uploads-permissions | `apps/api/src/routes/uploads.ts:168-181` | `GET /api/attachments/:id` returns storageKey for quarantined attachments without status check |
| **DB-001** | database | `apps/api/src/services/permissions-service.ts` `loadMemberContext` | 3 serial Prisma round-trips on every permission-gated route |
| **DB-002** | database | `apps/api/src/services/permissions-service.ts` `filterVisibleChannels` | O(N·5) sequential DB queries per channel-list/search |
| **DB-003** | database | `apps/api/src/routes/messages.ts` search | Full-text search via `ILIKE '%term%'` — Postgres sequential scan, no `pg_trgm` index |
| **DB-004** | database | message-create path | Redundant full row read after every message-create transaction |
| **RT-001** | realtime | `apps/api/src/gateway/index.ts:287-298` `shouldDeliver` | VOICE_STATE_UPDATE fanout uses server-level membership, leaks hidden channels |
| **FE-01** | frontend | `apps/web/vite.config.ts:29` | `sourcemap: true` ships full TS source to every browser |
| **FE-02** | frontend | `apps/web/src/lib/api-client.ts:24-25` | (dup of SEC-001) refresh token in localStorage |
| **INF-001** | infra | repo root | Missing LICENSE file (README+package.json declare MIT) |
| **INF-002** | infra | `docs/deployment.md` | `docker compose up -d` instruction doesn't engage `apps` profile — won't bring app up |
| **INF-003** | infra | `docs/native-setup.md` | Tells operators to edit `infra/garage/garage.toml` — a git-ignored, materialised file |
| **INF-004** | infra | `infra/traefik/dynamic.yml` | Points web service at port 3000, nginx container listens on 80 — connection refused |

---

## HIGH (57) — correctness, leaks, hot-path perf

### Security & auth (6)
| ID | File:line | Title |
|----|-----------|-------|
| SEC-005 | `apps/api/src/lib/jwt.ts` | JWT `audience` claim not set or validated |
| SEC-006 | `apps/api/src/services/auth-service.ts` lockout | Brute-force counter resets to zero on threshold — allows re-attempts after lock expires with no decay |
| SEC-007 | `apps/api/src/routes/auth.ts` rate limit | Login rate limit 20/min — insufficient for credential stuffing |
| SEC-008 | `apps/api/src/app.ts` headers | No Content-Security-Policy header on API responses |
| SEC-009 | `Session` model | No idle-timeout, no per-user session cap |
| SEC-010 | `apps/api/src/app.ts` | `@fastify/cookie` installed but cookies unused for token delivery |

### Permissions, uploads, storage (8)
| ID | File:line | Title |
|----|-----------|-------|
| UPL-002 | `apps/api/src/routes/uploads.ts` `sanitizeFilename` | Doesn't strip null bytes or Windows-reserved names (CON, PRN, etc.) |
| UPL-003 | `apps/api/src/services/upload-validator.ts` | `handout`/`file` kinds skip MIME validation |
| UPL-004 | `packages/media/src/storage/s3.ts` | S3 presigned PUT — no server-side content-type or content-length enforcement |
| STO-001 | `apps/api/src/routes/local-files.ts:82-126` | Local-file serve route has no quarantine-bucket guard |
| STO-002 | `packages/media/src/storage/local.ts` PendingUpload map | In-memory tickets, no eviction on restart, unbounded growth |
| PERM-003 | overwrites route | Channel overwrite `MANAGE_ROLES` lets target receive ADMINISTRATOR |
| PERM-004 | (dup of DB-002) `filterVisibleChannels` | N sequential DB round-trips |
| PERM-005 | overwrites route | Permission overwrite doesn't verify `targetId` belongs to channel's server |

### Database & perf (7)
| ID | File:line | Title |
|----|-----------|-------|
| DB-005 | message-create | Second full row read after transaction (could be returned from txn) |
| DB-006 | `getChannelPermissions` | Re-queries `Server.defaultRoleId` already fetched by `loadMemberContext` |
| DB-007 | `Session` schema | No `(userId, revokedAt)` partial index for active-session lookup |
| DB-008 | `ModerationAction` schema | No index on `reportId` or `serverId` |
| DB-009 | `AuditLogEntry` schema | No retention mechanism — unbounded growth |
| DB-010 | `Message` nonce constraint | Includes NULL rows, stale nonces never expire |
| DB-011 | `Attachment.status` index | Full-coverage index; partial on pending/processing would be more selective |

### Realtime & voice (10)
| ID | File:line | Title |
|----|-----------|-------|
| RT-002 | `apps/api/src/gateway/index.ts` | `socket.send()` fire-and-forget; no backpressure or slow-consumer eviction |
| RT-003 | `apps/api/src/gateway/index.ts` | 256-event buffer overflow: no INVALID_SESSION signal, no log |
| RT-004 | `apps/api/src/services/gateway-broker.ts:73-75` | Redis malformed-message silent drop with no log/DLQ |
| RT-005 | gateway fanout | Per-client per-event `getChannelPermissions` DB query (N+1 in fanout) |
| RT-006 | `LazyBroker.useRedis` | Swap loses all subscriptions registered before promotion — total Redis-mode blackout |
| RT-007 | voice route | Missing `stateTimer` clear in `leave()` — deferred state POST races leave |
| RT-008 | `/voice/leave` | No rate limit, N+1 update pattern |
| VC-001 | `apps/api/src/services/livekit-token.ts` | LiveKit token TTL 1 hour, no client-side refresh path — disconnects after 1 hour |
| VC-002 | gateway fanout | VOICE_STATE_UPDATE bypasses channel VIEW_CHANNEL check (structural gap, dup of RT-001) |
| RT-009 | gateway | Same user from two tabs → divergent voice state on tab close |

### Frontend (12)
| ID | File:line | Title |
|----|-----------|-------|
| FE-03 | `apps/web/src/routes/app-shell.tsx:45-60` | Stale closure over `params.serverId` and `navigate` in useEffect |
| FE-04 | `apps/web/src/components/VoiceRoom.tsx` | Stale `reportVoiceState` closure in join-effect handlers |
| FE-05 | `VoiceRoom.tsx` toggleMic | No error handling — throws silently on hardware failure |
| FE-06 | `MessageComposer.tsx` | MediaRecorder not stopped on unmount — mic light stays lit indefinitely |
| FE-07 | `MessageList.tsx` | Unconditional `scrollTop = scrollHeight` snaps user off history on every incoming message |
| FE-09 | `AttachmentView.tsx` | Fetch failure leaves "attachment loading..." indefinitely |
| FE-10 | `MemberSidebar.tsx` | Error indistinguishable from empty list, no loading state |
| FE-11 | `ReactionBar.tsx` | PUT/DELETE failures completely silent |
| FE-22 | `MessageList.tsx` delete | Uses `confirm()` + `alert()` for error feedback |
| FE-23 | channel sidebar | Channel fetch failures show "..." indefinitely with no error state |
| FE-24 | `MessageComposer.tsx` | No client-side file size or MIME type validation |
| FE-25 | `VoiceRoom.tsx` toggleMic | Optimistic mic state set before awaiting LiveKit response |

### Infrastructure (14)
| ID | File:line | Title |
|----|-----------|-------|
| INF-005 | `infra/livekit/livekit.yaml` vs `infra/docker/docker-compose.yml` | LiveKit UDP port range mismatch (50000-50100 vs 7882) |
| INF-006 | `apps/worker` docker | `restart: unless-stopped` + clean exit on missing REDIS_URL = restart loop |
| INF-007 | docker-compose api/worker | `depends_on garage: service_started` ignores healthcheck → cold-boot race |
| INF-008 | `apps/api/Dockerfile` | Runtime doesn't pin non-root uid or use tini exec form |
| DOC-001 | `docs/api.md` | Many routes missing or path-mismatched (25+ routes undocumented; 4 path mismatches) |
| DOC-002 | `docs/permissions.md` | No bit-position table |
| DOC-003 | `docs/permissions.md` | Summary list missing flags present in code |
| INF-009 | repo | No CI workflow directory, no pre-commit hooks |
| INF-010 | `.env.example` | Missing LOG_LEVEL, WEB_PORT, GARAGE_*_SECRET trio, rate-limit knobs |
| INF-011 | repo | No SECURITY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md |
| INF-012 | `docs/deployment.md` | Says Redis required; README/native-setup/production-hardening say optional |
| INF-013 | `scripts/garage-config.mjs` + `scripts/ensure-env.mjs` | Write secret files without `mode: 0o600` |
| DOC-004 | `docs/roadmap.md` | Phase 0 description stale vs current compose |

---

## MEDIUM (66) — UX, dead code, defense-in-depth, doc drift

### Security (9)
SEC-011 console.error in passwords.ts · SEC-012 console.warn in gateway-broker · SEC-013 disableRequestLogging hides security logs · SEC-014 invite uses not validated at join · SEC-015 default credentials in .env.example · SEC-016 no HSTS · SEC-017 unconditional trustProxy · SEC-018 server-scoped invite accepted for instance reg · SEC-019 vite path-traversal (dev dep)

### Permissions/Upload/Storage (10)
UPL-005 scan job not idempotent · STO-003 getPartialObject reads entire file · UPL-006 size validation BigInt vs number · PERM-006 ADMINISTRATOR bit 62 sign concern · PERM-007 @everyone deletable via DELETE /api/roles/:id · UPL-007 ALLOW_UNSCANNED_UPLOADS defaults true · STO-004 content-disposition leaks storage key · PERM-008 lock_account moderation not atomic · UPL-008 worker queue no dead-letter · PERM-009 gateway doesn't check server membership at IDENTIFY (banned users connect)

### Database (12)
DB-012 bitwise ops in JS not Postgres · DB-013 bootstrap user.count in non-serializable txn · DB-014 VoiceState upsert deadlock potential · DB-015 Session.expiresAt non-partial index · DB-016 Channel.campaignId/gameNightId unindexed FKs · DB-017 HandoutVisibleUser.userId unindexed · DB-018 CampaignNote/Handout authorId unindexed · DB-019 DiceRoll.userId unindexed · DB-020 STREAM_SCREEN backfill irreversible undocumented · DB-021 Message channelId+createdAt index used for cursor type mismatch · DB-022 Decimal→string conversion missing for sizeBytes · DB-023 Prisma connection pool not configured

### Realtime/Voice (7)
RT-010 RESUME re-READYs without buffer replay · RT-011 heartbeat sweeper skips pre-identified · RT-012 console.warn in LazyBroker · VC-003 typing shows raw UUID prefix · VC-004 stale typing persists 9s after tab close · VC-005 toggleMic optimistic before LiveKit ack · VC-006 brief empty-state flash on join

### Frontend (11)
FE-08 useMemo `() => messages, [messages]` no-op · FE-12 window.prompt() for emoji name · FE-13 confirm() for 6 destructive actions · FE-14 @tanstack/react-query installed unused (47KB) · FE-15 search requests not cancelled on fast typing · FE-16 setTimeout in ReportDialog not cleaned up · FE-17 magic 800ms setTimeout for emoji worker · FE-18 Toggle defined inside render function · FE-19 TypingIndicator shows UUID (dup of VC-003) · FE-20 AppHome shows internal "Phase 0" copy · FE-21 no route-level code splitting

### Infra/Docs (17)
INF-014 traefik no security-headers middleware · INF-015 nginx no gzip/brotli · INF-016 nginx no CSP/HSTS · INF-017 three inconsistent body-size caps (2/25/256 MB) · INF-018 ensure-env JWT 48 bytes hex (verify ≥32) · INF-019 60s garage health-wait may be short · INF-020 anonymous-read fallback warn-but-continue · INF-021 .dockerignore strips *.md · INF-022 web Dockerfile runs as root · INF-023 no docker resource limits · DOC-005 deployment.md "sticky-ish" contradicts production-hardening · DOC-006 docker-setup gotchas missing service_started race · DOC-007 docker-setup wipe command needs profile · DOC-008 architecture.md diagram wrong on ClamAV-Garage flow · DOC-009 architecture.md realtime sequence numbers caveat missing · DOC-010 README pnpm docker:up:all description wrong · INF-024 garage.toml.example secrets not random across forks

---

## LOW (44) — style, naming, marginal optimizations

### Security (6)
SEC-020 refresh-token rate limit 60/min too high · SEC-021 bootstrap-status not rate-limited · SEC-022 livekit-api-secret placeholder · SEC-023 X-Device-Name unauthenticated · SEC-024 undici vulnerable dev deps · SEC-025 nginx Permissions-Policy missing

### Permissions/Upload/Storage (8)
UPL-009 magic-byte returns true for unknown MIME · STO-005 S3 presigned URL hardcoded 600s · PERM-011 getChannelPermissions TOCTOU re-query · UPL-010 waveform endpoint pre-scan check · STO-006 absPath resolveSafe symlink confusion · PERM-012 role position can be negative or duplicated · PERM-013 computeBasePermissions ADMINISTRATOR no role-position guard · PERM-010 serializePermissions exposes raw BigInt

### Database (7)
DB-024 Invite.code redundant index · DB-025 BoardGame.ownerUserId unindexed · DB-026 GameNight.createdById unindexed · DB-027 Report.reporterId unindexed · DB-028 CampaignSessionRsvp.userId unindexed · DB-029 TIMESTAMP(3) not TIMESTAMPTZ · DB-030 No RLS (doc-only)

### Realtime/Voice (10)
RT-013 HELLO sessionId not stored client-side · RT-014 missed HEARTBEAT_ACK not detected · RT-015 reconnect backoff no jitter · RT-016 sendRaw catch swallows non-socket errors · RT-017 buildReadyPayload omits channels · VC-007 LiveKit Room no reconnect policy · VC-008 ScreenShareSettingsPopover onChange not guarded · VC-009 JoinResponse interface duplicates shared schema · VC-010 LiveKit token nbf magic-number offset · RT-018 INVALID_SESSION re-identifies in-place

### Frontend (6)
FE-26 TavernLogo SVG hex 17 lightness points off canvas · FE-27 SidebarChannelLink calls hook inside map · FE-28 VoiceRoom bg-black/40 vs bg-overlay/80 inconsistent · FE-29 Modal + ReportDialog both bg-black/60 scrims · FE-30 campaigns-page 4× exhaustive-deps suppressions, 624 LoC · FE-31 Waveform uses array index as React key

### Infra/Docs (7)
INF-025 pnpm version sync · INF-026 .gitignore verbose · INF-027 web Dockerfile no healthcheck · INF-028 compose volume drivers default · INF-029 traefik ACME no volume mount · DOC-011 walkthrough.md docker:up note · DOC-012 safety.md voice_messages no UI · DOC-013 roadmap Phase 6 production-hardening incomplete

---

## Phase 3 fix order (from plan)

1. **All 17 CRITICAL** — fix first, regardless of slice. These ship with integration tests written first.
2. **HIGH security/correctness** (SEC-005 to SEC-010, PERM-003 to PERM-005, UPL-002 to UPL-004, STO-001 to STO-002, RT-001 family, RT-006, RT-007, FE-03 to FE-11, plus INF-004 to INF-008, DOC-001 to DOC-003)
3. **HIGH performance** (DB-005 to DB-011, RT-002 to RT-005, RT-008, INF-009 to INF-013)
4. **Integration test backfill** for any route touched in 1-3, plus the P0 list from `test-coverage.md`
5. **MEDIUM cleanup** in slice order — security, perm/upload, database, realtime, frontend, infra/docs
6. **LOW** — picked off in batches by slice

## Slice ownership map (for commit grouping)

| Slice | CRITICAL | HIGH | MEDIUM | LOW | Total |
|-------|----------|------|--------|-----|-------|
| Security (SEC-) | 4 | 6 | 9 | 6 | 25 |
| Uploads/Permissions (PERM/UPL/STO-) | 3 | 8 | 10 | 8 | 29 |
| Database (DB-) | 4 | 7 | 12 | 7 | 30 |
| Realtime/Voice (RT/VC-) | 1 | 10 | 7 | 10 | 28 |
| Frontend (FE-) | 2 | 12 | 11 | 6 | 31 |
| Infra/Docs (INF/DOC-) | 4 | 14 | 17 | 7 | 42 |
| (test-coverage finds no IDs — gates Phase 4) | — | — | — | — | — |

> Note: SEC-001/FE-02 and DB-002/PERM-004 and RT-001/VC-002 are deduplicated single fixes despite appearing on two slices' lists.

## Cross-cutting themes (single fix touches many findings)

- **Cookie-based auth** (SEC-001, SEC-010, FE-02) — issue refresh token as httpOnly cookie, keep access token in memory only
- **Request-scoped permission cache** (DB-001, DB-002, DB-006, PERM-004, RT-005) — Fastify `decorateRequest('memberContext', null)` lazy load
- **Structured logging everywhere** (SEC-011, SEC-012, RT-012, RT-004, RT-016) — replace every `console.*` in API with Pino child loggers
- **Toast/ErrorAlert UX** (FE-09, FE-10, FE-11, FE-22, FE-23) — single error-toast helper, replace all silent catches
- **Audit-log retention** (DB-009, all moderation findings) — migration + scheduled cron in worker
- **Index pass on Prisma schema** (DB-007, DB-008, DB-016-019, DB-025-028) — one migration adding all missing FK indexes
- **`docs/api.md` regeneration** (DOC-001, DOC-002, DOC-003) — sweep every route file, regenerate endpoint table
- **Body-size caps unified** (INF-017) — single `UPLOAD_MAX_BYTES` env propagated to Fastify, nginx, S3 presign
- **Security-header layer in nginx** (INF-015, INF-016, SEC-008, SEC-016, SEC-025) — single nginx block adds CSP, HSTS, gzip, brotli, Permissions-Policy
