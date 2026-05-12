# Database & Performance Review

## Summary

Tavern's schema is well-structured with foreign keys consistently indexed and cascade rules deliberately chosen. The primary performance liabilities are in the permission-resolution hot path, which issues 3–4 serial round-trips per permission-gated request, and in `filterVisibleChannels`, which loops N channel permission checks sequentially — an O(N) N+1 pattern that degrades linearly with channel count. Message search relies on `ILIKE '%term%'` with no GIN index, which produces a full sequential scan against `Message`. Audit log and nonce-carrying message rows have no retention mechanism, creating unbounded table growth.

---

## Critical Findings

### [DB-001] `loadMemberContext` issues 3 serial queries on every permission-gated route

- **Severity:** CRITICAL
- **File:** `apps/api/src/services/permissions-service.ts:21-52`
- **Issue:** Every call to `loadMemberContext` executes three sequential awaited Prisma calls: (1) `server.findUnique` for `ownerUserId`/`defaultRoleId`, (2) `serverMember.findUnique` with `include: { roles: { include: { role: true } } }`, (3) `role.findUnique` for the `@everyone` permissions. `getChannelPermissions` adds a fourth query (`channel.findUnique`) plus a fifth (`permissionOverwrite.findMany`) plus a sixth redundant `server.findUnique` for `defaultRoleId` (already fetched in `loadMemberContext` two lines earlier). A typical message-send flows through `requireChannelPermission` → `getChannelPermissions` → `loadMemberContext`, totalling **6 database round-trips before the message is written**.
- **Impact:** At 200 concurrent users each sending 1 message every 5 seconds, this is 240 permission-lookup queries per second from this path alone, each blocking on the previous. Latency stacks; P99 request time climbs proportionally to DB RTT.
- **Fix:** Collapse the 3 `loadMemberContext` queries into one joined query:
  ```sql
  SELECT s."ownerUserId", s."defaultRoleId",
         r_everyone."permissions" AS "everyonePermissions",
         smr."roleId", role."permissions" AS "rolePermissions"
  FROM   "Server" s
  LEFT   JOIN "ServerMember" sm ON sm."serverId" = s.id AND sm."userId" = $userId
  LEFT   JOIN "ServerMemberRole" smr ON smr."serverId" = sm."serverId" AND smr."userId" = sm."userId"
  LEFT   JOIN "Role" role ON role.id = smr."roleId"
  LEFT   JOIN "Role" r_everyone ON r_everyone.id = s."defaultRoleId"
  WHERE  s.id = $serverId
  ```
  Alternatively, add a request-scoped Fastify decorator (e.g. `req.permCache`) keyed by `serverId:userId` to memoize across multiple `requireChannelPermission` calls within the same request lifecycle.

---

### [DB-002] `filterVisibleChannels` is an N+1 query pattern on the channel-list hot path

- **Severity:** CRITICAL
- **File:** `apps/api/src/services/permissions-service.ts:149-165` and `apps/api/src/routes/servers.ts:209-214`, `apps/api/src/routes/search.ts:44`
- **Issue:** `filterVisibleChannels` iterates over every channel and calls `getChannelPermissions` in a sequential `for` loop. `getChannelPermissions` itself invokes `loadMemberContext` (3 queries) + `permissionOverwrite.findMany` + `server.findUnique` for each channel. A server with 20 channels generates **≥100 sequential queries** when listing channels or executing a search. The search route calls this for every text-type channel in the server before filtering by the search term.
- **Impact:** Channel-list requests on servers with 20+ channels will exceed 200ms from query overhead alone. Under concurrent load this saturates the connection pool.
- **Fix:** Load all `PermissionOverwrite` rows for the server in one batch query keyed by `channelId`. Compute the permission for all channels in application code using the single loaded `MemberContext`. This reduces N queries to 2 (one for overwrites, one for member context, reused from `loadMemberContext`).

---

### [DB-003] Full-text search uses `ILIKE '%term%'` — sequential scan on `Message`

- **Severity:** CRITICAL
- **File:** `apps/api/src/routes/search.ts:60-77`
- **Issue:** The search query uses `content: { contains: q.q, mode: 'insensitive' }` which Prisma translates to `WHERE "content" ILIKE '%term%'`. A leading wildcard defeats all B-tree indexes. On a server with 1M messages in 20 channels, this is a full table scan filtered by `channelId IN (...)`. No GIN or `pg_trgm` index exists on `Message.content`.
- **Impact:** A single search request can take seconds and pin a CPU core, holding a connection. Under concurrent searches it becomes a denial-of-service vector.
- **Fix:** Add a `pg_trgm` GIN index:
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX message_content_trgm_idx ON "Message" USING GIN ("content" gin_trgm_ops)
    WHERE "deletedAt" IS NULL;
  ```
  Alternatively, enable Prisma's `fullTextSearch` preview feature (already declared in `generator client`) and use `mode: 'postgresql'` with `search: term` which uses the built-in `to_tsvector`/`plainto_tsquery` path. Either approach eliminates the seq scan.

---

### [DB-004] `POST /api/voice/leave` issues N+1 individual `voiceState.update` calls

- **Severity:** CRITICAL
- **File:** `apps/api/src/routes/voice.ts:171-192`
- **Issue:** `POST /api/voice/leave` first calls `voiceState.findMany({ where: { userId } })` to retrieve all voice states, then iterates the result set and issues one `voiceState.update` **per row** inside a `for` loop. A user who is a member of 10 servers generates 11 database queries (1 find + 10 updates) on leave.
- **Impact:** While uncommon, multi-server membership is a design-supported scenario. The loop holds open a sequence of round-trips while publishing gateway events in between, holding the request open unnecessarily.
- **Fix:** Use `voiceState.updateMany({ where: { userId }, data: { channelId: null, joinedAt: null, selfMute: false, selfDeaf: false, cameraOn: false, screenSharing: false } })` for the DB writes, then publish gateway events using the previously fetched `states` array without re-querying.

---

## High Findings

### [DB-005] `POST /api/channels/:id/messages` issues a second full row read after the transaction

- **Severity:** HIGH
- **File:** `apps/api/src/routes/messages.ts:154-161`
- **Issue:** After the `prisma.$transaction` block that creates the message and optionally updates attachments, the code immediately issues `prisma.message.findUnique` to re-read the just-created row with `include: { attachments, reactions }`. The transaction already has the ID; the attachments were just linked by the same transaction; the reaction set is always empty on a brand-new message.
- **Impact:** Every message-send costs one extra round-trip. At 100 msg/s this is 100 wasted queries/s — measurable under load.
- **Fix:** Either return the created message from within the transaction using a final `tx.message.findUnique` call inside `$transaction`, or construct the DTO directly from the data already in scope (message row + `body.attachmentIds`, empty reactions array) without a second DB call.

---

### [DB-006] `getChannelPermissions` re-queries `Server.defaultRoleId` after `loadMemberContext` already fetched it

- **Severity:** HIGH
- **File:** `apps/api/src/services/permissions-service.ts:82-86`
- **Issue:** Lines 82–86 issue `prisma.server.findUnique({ where: { id: channel.serverId }, select: { defaultRoleId: true } })` to get the everyone-role ID for overwrite matching. `loadMemberContext` already fetched `server.defaultRoleId` on line 22 but discards it; the everyone-role permissions are loaded but the ID is not returned. This causes an unconditional extra query on every call to `getChannelPermissions` when the caller is not the owner.
- **Impact:** Every non-owner, non-admin channel permission check wastes one query. Combined with DB-001, a message-send by a regular member costs at minimum 6 queries.
- **Fix:** Return `defaultRoleId` from `loadMemberContext` alongside the other fields and consume it in `getChannelPermissions`.

---

### [DB-007] `Session` table has no index on `(userId, revokedAt)` for active-session queries

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:92`, `apps/api/src/services/auth-service.ts:279`
- **Issue:** The session table has `@@index([userId])` and `@@index([expiresAt])` but no compound index on `(userId, revokedAt)`. In `auth-service.ts`, refresh-token reuse detection calls `prisma.session.updateMany({ where: { userId, revokedAt: null } })`. This uses the `userId` index but must then filter `revokedAt IS NULL` with a heap re-check. A user with many historical sessions (all revoked or expired) causes wasted heap reads.
- **Impact:** The reuse detection path is a security-critical operation; slowness here causes denial-of-service after a token theft scenario. With 1000 sessions per user across time, each reuse-detection sweep reads 1000 index entries.
- **Fix:**
  ```sql
  CREATE INDEX session_userid_revokedat_idx ON "Session" ("userId", "revokedAt")
    WHERE "revokedAt" IS NULL;
  ```
  This partial index covers only active sessions.

---

### [DB-008] `ModerationAction` has no index on `reportId` or `serverId`

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:790-805`
- **Issue:** `ModerationAction` has only `@@index([targetType, targetId])`. The `reportId` and `serverId` columns are unindexed foreign keys. Report resolution queries and any future "list actions for a server" query will table-scan.
- **Impact:** Moderate now; degrades as moderation history grows. `reportId` is especially important since it is the FK used to join actions to their parent report.
- **Fix:**
  ```sql
  CREATE INDEX moderation_action_reportid_idx ON "ModerationAction" ("reportId");
  CREATE INDEX moderation_action_serverid_idx ON "ModerationAction" ("serverId");
  ```

---

### [DB-009] `AuditLogEntry` has no retention mechanism — unbounded growth

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:807-822`, `apps/api/src/routes/moderation.ts:243-261`
- **Issue:** Audit log entries are written on every moderation action, server/channel/role mutation, and user event. There is no TTL, archival, or deletion job. The audit log endpoint fetches up to 200 rows (`take: 200`) without cursor pagination. With heavy server activity (e.g. a spam raid generating hundreds of moderation events), the table can grow by thousands of rows per hour indefinitely.
- **Impact:** Over months, `AuditLogEntry` becomes the largest table. `SELECT ... WHERE serverId = $id ORDER BY createdAt DESC LIMIT 200` remains fast due to the existing `@@index([serverId, createdAt])`, but total storage and autovacuum pressure grow without bound.
- **Fix:**
  1. Add a `pg_cron` or worker-based retention job: `DELETE FROM "AuditLogEntry" WHERE "createdAt" < NOW() - INTERVAL '90 days'`.
  2. Add cursor-based pagination to the audit log endpoint using `WHERE id < $cursor` rather than bare `take: 200`.
  3. Consider partitioning by `createdAt` month for very active instances.

---

### [DB-010] Message `nonce` unique constraint includes NULL rows — stale nonces never expire

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:323`, `apps/api/src/routes/messages.ts:82-94`
- **Issue:** The schema declares `@@unique([channelId, nonce])` which Postgres implements as a unique index over `(channelId, nonce)`. Postgres treats each NULL as distinct, so `nonce = NULL` rows are excluded from uniqueness checks — that is correct. However, non-NULL nonces persist forever. A client sending the same nonce months later would hit the idempotency short-circuit and receive a 200 with the original (potentially deleted) message object.
- **Impact:** Idempotency becomes permanently sticky rather than a short-lived guard. Over time the index accumulates all historical nonces from all clients, growing unboundedly.
- **Fix:** Add a partial index / constraint that is only meaningful for recent messages, combined with a cleanup job:
  ```sql
  -- Stale nonce cleanup job (run daily):
  UPDATE "Message" SET "nonce" = NULL
  WHERE  "nonce" IS NOT NULL
    AND  "createdAt" < NOW() - INTERVAL '24 hours';
  ```
  The existing unique constraint remains valid; only the application lookup needs to narrow the window (`WHERE createdAt > NOW() - INTERVAL '24 hours'` in the nonce-check query).

---

### [DB-011] `Attachment` status index covers all statuses — a partial index on pending/processing would be more selective

- **Severity:** HIGH
- **File:** `packages/db/prisma/schema.prisma:376`
- **Issue:** `@@index([status])` indexes all 7 status values. Worker sweep queries for `pending` and `quarantined` attachments will scan index entries for `ready` and `blocked` rows, which are the majority. There is also no index on `createdAt` for staleness sweeps.
- **Fix:**
  ```sql
  -- Drop the full-status index and replace with a partial:
  DROP INDEX "Attachment_status_idx";
  CREATE INDEX attachment_pending_idx ON "Attachment" ("createdAt")
    WHERE "status" IN ('pending', 'processing', 'quarantined');
  ```

---

## Medium Findings

### [DB-012] Permission bitwise operations performed entirely in JavaScript, not Postgres

- **Severity:** MEDIUM
- **File:** `apps/api/src/services/permissions-service.ts:37-50`, `packages/db/prisma/schema.prisma:178`
- **Issue:** Permissions are stored as `DECIMAL(20,0)`. Prisma returns them as `Prisma.Decimal` objects. The code calls `.toString()` on each, then `parsePermissions()` (which converts to `BigInt`), then performs JS bitwise AND/OR. This means: (a) every permission check fetches full rows with `permissions` column, (b) no permission filtering is pushed to Postgres, (c) future queries like "find all roles that allow X" require loading all roles and filtering in JS. `BigInt` construction from string is non-trivial.
- **Impact:** Medium at current scale. Becomes relevant at large role counts or if permission-filtered queries are added.
- **Fix:** For the current sequential approach the JS path is acceptable. For future queries that filter by permission bits, use Postgres:
  ```sql
  SELECT id FROM "Role"
  WHERE  ("permissions"::bigint & $flag) = $flag
    AND  "serverId" = $serverId;
  ```

---

### [DB-013] `bootstrap` transaction calls `user.count()` inside a transaction without serializable isolation

- **Severity:** MEDIUM
- **File:** `apps/api/src/services/auth-service.ts:130-218`
- **Issue:** The bootstrap transaction checks `tx.user.count()` and aborts if `> 0`. But `prisma.$transaction` defaults to the database's default isolation level (READ COMMITTED in Postgres). Two concurrent bootstrap requests could both read `count = 0`, both proceed past the check, and both attempt to create the first admin user — only the second would fail with a unique constraint violation on `username`/`email`. This is a narrow TOCTOU window but it exists.
- **Impact:** Low probability in practice (bootstrap happens once), but could leave a partially initialised server.
- **Fix:** Use `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }` in the `$transaction` options, or use `INSERT ... ON CONFLICT DO NOTHING` with a known sentinel row to serialize the check.

---

### [DB-014] `VoiceState` upsert on join — no lock ordering; concurrent joins to same channel can deadlock

- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/voice.ts:113-146`
- **Issue:** The voice join path executes `voiceState.updateMany` (stale sweep) followed by `voiceState.upsert` outside a transaction. If two users join the same voice channel simultaneously, both may race to upsert rows that reference the same `channelId` FK without a consistent lock ordering. Under Postgres's row-level locking, an upsert on a non-existent row acquires a gap lock; concurrent inserts on the same PK can deadlock.
- **Impact:** Low probability but non-zero in rooms where many users join simultaneously (e.g. at the start of a session).
- **Fix:** Wrap the stale-sweep + upsert in a single `$transaction` and ensure the upsert uses `ON CONFLICT (serverId, userId) DO UPDATE` (which Prisma's upsert generates correctly). The transaction serializes the two operations on the same row.

---

### [DB-015] `Session.expiresAt` index is not a partial index — expired sessions bloat it

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/schema.prisma:93`
- **Issue:** `@@index([expiresAt])` indexes all sessions including expired and revoked ones. No cleanup job exists to prune expired sessions. The `refresh` path does not delete expired sessions; it only revokes them. Over time the session table grows indefinitely.
- **Fix:**
  1. Add a cleanup job: `DELETE FROM "Session" WHERE "expiresAt" < NOW() - INTERVAL '7 days'`.
  2. Replace the full index with a partial: `CREATE INDEX session_expiresat_active ON "Session" ("expiresAt") WHERE "revokedAt" IS NULL`.

---

### [DB-016] `Channel.campaignId` and `Channel.gameNightId` foreign keys are unindexed

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/schema.prisma:222-223`
- **Issue:** `Channel.campaignId` (FK → `Campaign`) and `Channel.gameNightId` (FK → `GameNight`) have no `@@index`. Queries like "list all channels for a campaign" require a sequential scan of the channel table filtered by `serverId` (covered) + `campaignId` (not covered), or a table scan if `serverId` is not in the WHERE clause.
- **Fix:**
  ```sql
  CREATE INDEX channel_campaignid_idx ON "Channel" ("campaignId") WHERE "campaignId" IS NOT NULL;
  CREATE INDEX channel_ganenightid_idx ON "Channel" ("gameNightId") WHERE "gameNightId" IS NOT NULL;
  ```

---

### [DB-017] `HandoutVisibleUser.userId` foreign key is unindexed

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/schema.prisma:588-596`
- **Issue:** `HandoutVisibleUser` has a composite PK on `(handoutId, userId)` which indexes by `handoutId` first. Queries filtering by `userId` (e.g., "which handouts can this user see?") require a table scan. There is no `@@index([userId])`.
- **Fix:**
  ```sql
  CREATE INDEX handout_visible_user_userid_idx ON "HandoutVisibleUser" ("userId");
  ```

---

### [DB-018] `CampaignNote.authorId` and `Handout.authorId` foreign keys are unindexed

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/schema.prisma:549, 570`
- **Issue:** `CampaignNote.authorId` and `Handout.authorId` are FK columns with no indexes. User-specific note lookups ("all notes by this user") require table scans.
- **Fix:**
  ```sql
  CREATE INDEX campaign_note_authorid_idx ON "CampaignNote" ("authorId");
  CREATE INDEX handout_authorid_idx ON "Handout" ("authorId");
  ```

---

### [DB-019] `DiceRoll.userId` foreign key is unindexed

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/schema.prisma:609`
- **Issue:** `DiceRoll` has `@@index([channelId, createdAt])` but no index on `userId`. A "my dice rolls" query requires a scan of the `channelId` index with heap re-checks for `userId`.
- **Fix:**
  ```sql
  CREATE INDEX dice_roll_userid_idx ON "DiceRoll" ("userId");
  ```

---

### [DB-020] `STREAM_SCREEN` backfill migration is irreversible and undocumented as such

- **Severity:** MEDIUM
- **File:** `packages/db/prisma/migrations/20260511181830_default_screen_share/migration.sql`
- **Issue:** This migration performs a data mutation (`UPDATE "Role" SET permissions = ...`) with no corresponding down-migration. Prisma migrations are one-way by design, but the backfill grants a permission bit to all `@everyone` roles. If the migration is rolled back (which Prisma doesn't support natively but operators sometimes attempt manually), roles will retain the `STREAM_SCREEN` permission incorrectly. The migration file has no comment marking it as irreversible.
- **Impact:** Low probability; no automatic rollback exists. Risk is during manual incident recovery.
- **Fix:** Add a comment at the top: `-- ONE-WAY: This migration grants STREAM_SCREEN to all @everyone roles. There is no safe rollback; to revert, run a targeted UPDATE with the bit cleared.`

---

### [DB-021] `Message.channelId + createdAt` index is used for `WHERE id > $cursor ORDER BY id` — type mismatch

- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/messages.ts:43-59`
- **Issue:** The message listing uses `orderBy: { id: 'desc' }` and `where: { id: { lt: query.before } }` for cursor pagination (ULID-based). This is correct and efficient because ULIDs sort chronologically. However, the schema defines `@@index([channelId, createdAt])` — this compound index helps for `createdAt`-ordered queries but is not used by the `id`-ordered query path. Postgres will use the PK index for the `id` range scan, and then apply the `channelId` filter as a heap re-check unless there is a covering index on `(channelId, id)`.
- **Fix:**
  ```sql
  CREATE INDEX message_channelid_id_idx ON "Message" ("channelId", "id" DESC)
    WHERE "deletedAt" IS NULL;
  ```
  This covers the hot pagination query and the soft-delete filter simultaneously.

---

### [DB-022] `Prisma.Decimal` → string conversion absent from `AttachmentRow.sizeBytes` serialization

- **Severity:** MEDIUM
- **File:** `apps/api/src/lib/serializers.ts:162`
- **Issue:** `Attachment.sizeBytes` is declared as `BigInt` in Postgres (`BIGINT` column). Prisma returns it as a JS `bigint`. In `serializeAttachment`, it is converted with `Number(row.sizeBytes)`. For files larger than `Number.MAX_SAFE_INTEGER` (≈ 9 petabytes), this silently loses precision. While this limit is not realistic today, the pattern is fragile. By contrast, the `Decimal` permission fields are correctly converted to strings via `.toString()`.
- **Fix:** Use `row.sizeBytes.toString()` on the wire and declare the DTO field as `string` (or validate it is within safe integer bounds before `Number()` conversion). The current approach is fine for any file size under 9007 TB, but document the limit or switch to string serialization.

---

### [DB-023] Prisma connection pool size not configured for multi-replica deployments

- **Severity:** MEDIUM
- **File:** `docs/production-hardening.md:57-59`
- **Issue:** The production hardening doc notes "Default Prisma pool is 10 — tune if you run multiple API replicas." No `connection_limit` is set in `DATABASE_URL` or via `prisma.$connect()` options anywhere in the codebase. With 3 API replicas each using the default pool of 10, the database receives 30 concurrent connections. Postgres 16's default `max_connections` is 100; under load this can exhaust connections.
- **Fix:** Set `DATABASE_URL` with an explicit pool parameter: `postgresql://...?connection_limit=5&pool_timeout=10` and document the formula: `(max_connections - reserved) / replica_count` for `connection_limit`.

---

## Low Findings

### [DB-024] `Invite.code` has both a UNIQUE index and a separate non-unique `@@index([code])` — redundant

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma:122-123`, migration line 549 and 555
- **Issue:** The migration creates `UNIQUE INDEX "Invite_code_key"` (from `@unique`) and also `INDEX "Invite_code_idx"` (from `@@index([code])`). The unique index already covers all lookup queries on `code`; the second index is redundant and wastes space and write overhead.
- **Fix:** Remove `@@index([code])` from the schema; the `@unique` annotation on the field is sufficient.

---

### [DB-025] `BoardGame.ownerUserId` FK is unindexed

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma:638`
- **Issue:** `BoardGame.ownerUserId` is a nullable FK with no index. "List board games I own" queries table-scan by `serverId` (covered) then filter by `ownerUserId` with heap re-checks.
- **Fix:**
  ```sql
  CREATE INDEX board_game_owneruserid_idx ON "BoardGame" ("ownerUserId") WHERE "ownerUserId" IS NOT NULL;
  ```

---

### [DB-026] `GameNight.createdById` FK is unindexed

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma:675`
- **Issue:** `GameNight.createdById` is a mandatory FK with no index beyond what is implied by the PK. "My game nights" queries will scan the `serverId` index then heap-filter.
- **Fix:**
  ```sql
  CREATE INDEX game_night_createdbyid_idx ON "GameNight" ("createdById");
  ```

---

### [DB-027] `Report.reporterId` FK is unindexed

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma:773`
- **Issue:** `Report.reporterId` has no index. "Reports filed by this user" (for abuse tracking or rate-limiting reporters) require a full scan.
- **Fix:**
  ```sql
  CREATE INDEX report_reporterid_idx ON "Report" ("reporterId");
  ```

---

### [DB-028] `CampaignSessionRsvp.userId` FK is unindexed

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma:529`
- **Issue:** The composite PK is `(sessionId, userId)`, indexed leading on `sessionId`. A user-centric query ("all RSVPs for this user") requires a table scan.
- **Fix:**
  ```sql
  CREATE INDEX campaign_session_rsvp_userid_idx ON "CampaignSessionRsvp" ("userId");
  ```

---

### [DB-029] All timestamps use `TIMESTAMP(3)` (without time zone) rather than `TIMESTAMPTZ`

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma` — all `DateTime` fields
- **Issue:** Prisma's `DateTime` maps to `TIMESTAMP(3)` (without timezone) in Postgres. All timestamps in this schema are stored as local timestamps. Prisma always inserts UTC, so in practice this is safe as long as the Postgres server and application servers are all UTC. However, if any replica or backup tool uses a non-UTC locale, timestamp arithmetic and display will be wrong without the explicit `WITH TIME ZONE` type.
- **Impact:** Low as long as servers are UTC (standard for containers). Documented risk.
- **Fix:** Add `@db.Timestamptz` annotations to all `DateTime` fields if the Prisma version supports it, or rely on the operational convention of always running Postgres in UTC.

---

### [DB-030] No Row Level Security policies — appropriate for single-tenant but should be documented

- **Severity:** LOW
- **File:** `packages/db/prisma/schema.prisma` (all models)
- **Issue:** No RLS policies are defined. Tavern is a single-tenant self-hosted application (one DB per instance) so RLS is not strictly required. However, if the Postgres database is shared with other services or if the DB user is not restricted, any compromised query can access all data.
- **Impact:** Low for the intended deployment model. Risk increases if operators share a Postgres cluster.
- **Fix:** Document in `docs/production-hardening.md` that the application DB user should be a non-superuser with `CONNECT` and table-level `SELECT/INSERT/UPDATE/DELETE` only — no `CREATE TABLE`, no `TRUNCATE`. Add a checklist item.

---

## Performance Hot Spots (Ranked)

1. [DB-002] `filterVisibleChannels` N+1 loop — O(N * 5) queries per channel-list or search request. Most damaging finding for perceived latency at any channel count above 5.
2. [DB-001] `loadMemberContext` 3-query serial chain — fires on every permission-gated route (all message sends, all reads, all reactions). 6 queries minimum per message-send.
3. [DB-003] `ILIKE '%term%'` full table scan on `Message.content` — can block a CPU core for seconds on large tables; denial-of-service risk.
4. [DB-004] `POST /api/voice/leave` N+1 per server — less frequent but proportional to membership count.
5. [DB-005] Extra `findUnique` after message creation transaction — every message post.
6. [DB-006] Redundant `server.findUnique` for `defaultRoleId` — fires in every non-owner channel permission check.
7. [DB-009] Unbounded `AuditLogEntry` table — storage and autovacuum overhead, not query latency.

---

## Index Recommendations

All recommendations below are additive migrations. None remove existing indexes.

```sql
-- [DB-007] Active sessions only
CREATE INDEX session_userid_active_idx ON "Session" ("userId", "revokedAt")
  WHERE "revokedAt" IS NULL;

-- [DB-008] ModerationAction FKs
CREATE INDEX moderation_action_reportid_idx    ON "ModerationAction" ("reportId");
CREATE INDEX moderation_action_serverid_idx    ON "ModerationAction" ("serverId");

-- [DB-011] Attachment sweep — pending/processing only
CREATE INDEX attachment_pending_sweep_idx ON "Attachment" ("createdAt")
  WHERE "status" IN ('pending', 'processing', 'quarantined');

-- [DB-015] Active sessions by expiry
CREATE INDEX session_expiresat_active_idx ON "Session" ("expiresAt")
  WHERE "revokedAt" IS NULL;

-- [DB-016] Channel FK coverage
CREATE INDEX channel_campaignid_idx   ON "Channel" ("campaignId")  WHERE "campaignId"  IS NOT NULL;
CREATE INDEX channel_ganenightid_idx  ON "Channel" ("gameNightId") WHERE "gameNightId" IS NOT NULL;

-- [DB-017] HandoutVisibleUser by user
CREATE INDEX handout_visible_user_userid_idx ON "HandoutVisibleUser" ("userId");

-- [DB-018] Note/handout author coverage
CREATE INDEX campaign_note_authorid_idx ON "CampaignNote" ("authorId");
CREATE INDEX handout_authorid_idx       ON "Handout" ("authorId");

-- [DB-019] DiceRoll by user
CREATE INDEX dice_roll_userid_idx ON "DiceRoll" ("userId");

-- [DB-021] Message pagination (channelId + id cursor, soft-delete filtered)
CREATE INDEX message_channelid_id_desc_idx ON "Message" ("channelId", "id" DESC)
  WHERE "deletedAt" IS NULL;

-- [DB-003] Full-text search via trigram (requires pg_trgm extension)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX message_content_trgm_idx ON "Message" USING GIN ("content" gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

-- [DB-025] BoardGame owner
CREATE INDEX board_game_owneruserid_idx ON "BoardGame" ("ownerUserId")
  WHERE "ownerUserId" IS NOT NULL;

-- [DB-026] GameNight creator
CREATE INDEX game_night_createdbyid_idx ON "GameNight" ("createdById");

-- [DB-027] Report by reporter
CREATE INDEX report_reporterid_idx ON "Report" ("reporterId");

-- [DB-028] RSVP by user
CREATE INDEX campaign_session_rsvp_userid_idx ON "CampaignSessionRsvp" ("userId");
```

---

## Positive Notes

- **ULID primary keys** are an excellent choice: monotonically increasing, URL-safe, cluster-friendly, no seq-scan-on-insert penalty, and enable cursor-based pagination by ID natively.
- **Cascade rules are deliberately chosen**: `User → Session`, `User → Message` use `CASCADE`; `Server → ownerUserId` uses `RESTRICT` (prevents orphaned servers); `Campaign → gmUserId` uses `RESTRICT`; invite and emoji creator FKs use `SET NULL` (correct for soft membership). No orphan risks were found in the cascade graph.
- **The `Decimal(20,0)` permission storage** correctly fits an unsigned 64-bit integer without overflow. The concern is ergonomic (JS BigInt round-tripping), not a correctness defect.
- **The `@@unique([channelId, nonce])` constraint** correctly uses Postgres NULL semantics (two NULLs are not considered equal) so messages without a nonce never block each other.
- **The `Message.channelId + createdAt` compound index** is in the correct column order for equality-then-range queries. The cursor approach using `id` rather than `OFFSET` is the right pattern for large message histories.
- **`STREAM_SCREEN` backfill migration** is idempotent (`AND ((permissions::bigint) & 134217728) = 0` guard) — safe to re-run.
- **`Session.refreshTokenHash`** is a UNIQUE-indexed SHA-256 hash rather than the raw token, which prevents the hash column from being usable as a login credential even if the DB is read by an attacker.
- **Transaction scope in auth service**: password hashing is done before the transaction opens (lines 69, 120 in `auth-service.ts`), so the expensive bcrypt call does not hold a DB connection. This is the correct pattern.
- **Worker scan jobs**: the scan job does not hold a DB transaction open during the ClamAV network call. The `runScanJob` function reads the attachment row, performs the scan, then updates the status — three separate operations. This avoids holding DB locks during IO.
