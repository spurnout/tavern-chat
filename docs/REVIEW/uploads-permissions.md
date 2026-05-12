# Permissions, Storage & Upload Review

## Summary

The permission bitset architecture, storage abstraction, and upload pipeline are generally well-designed with defense-in-depth applied at multiple layers. However, several meaningful gaps exist: the attachment metadata API returns a public URL for quarantined/blocked files (the URL is nil, but the `storageKey` is still exposed), the `sanitizeFilename()` function used to build storage keys is applied correctly but misses null bytes and Windows-reserved names, the role assignment endpoint allows a `MANAGE_ROLES` holder to grant roles above their own position (privilege escalation), there is no `ServerBan` model so the BAN_MEMBERS permission flag has no enforcement path and a banned user can reconnect via the gateway, and the default `ALLOW_UNSCANNED_UPLOADS=true` combined with no ClamAV in the default dev/production install means most real deployments accept uploads without any virus scanning.

---

## Critical Findings

### [PERM-001] Role privilege escalation — MANAGE_ROLES lets any moderator grant roles above their own
- **Severity:** CRITICAL
- **File:** `apps/api/src/routes/roles.ts:119-166`
- **Issue:** `PUT /api/servers/:serverId/members/:userId/roles` accepts any `roleIds[]` and only validates that each ID belongs to the server and is not `@everyone`. There is no check that the acting user's highest role position is above the roles being assigned. A user with `MANAGE_ROLES` can therefore promote themselves or others to any role in the server, including administrator-level roles they do not hold.
- **Impact:** Privilege escalation to ADMINISTRATOR. A low-privilege moderator can self-promote to full server control.
- **Repro:** 1) Create a server with two roles: `Mod` (position 1, `MANAGE_ROLES`) and `Admin` (position 2, `ADMINISTRATOR`). 2) Assign yourself `Mod`. 3) `PUT /api/servers/<id>/members/<self>/roles` with `{ roleIds: [<admin-role-id>] }`. 4) You now hold `ADMINISTRATOR`.
- **Fix:** Before the role assignment transaction, fetch the actor's current highest role position. Reject the request if any requested roleId has a position >= the actor's highest position. Apply same guard in `PATCH /api/roles/:id` for permission changes.

### [PERM-002] Ban enforcement missing entirely — BAN_MEMBERS flag has no backend implementation
- **Severity:** CRITICAL
- **File:** `packages/db/prisma/schema.prisma` (no `ServerBan` model), `packages/shared/src/permissions.ts:40`
- **Issue:** `Permission.BAN_MEMBERS` is defined at bit 16, but there is no `ServerBan` (or equivalent) Prisma model, no route to ban a member, and no gateway check that rejects connections from banned users. The moderation `lock_account` action applies a time-limited lock but that is not a ban; after the lock expires the user retains membership. Banned users can also reconnect to the gateway using a valid token immediately after a `kick` because membership is not checked at gateway IDENTIFY time.
- **Impact:** BAN_MEMBERS permission is a decorative flag. A kicked or "banned" user can rejoin through any valid invite or simply by reconnecting if their membership row was not deleted.
- **Fix:** Add a `ServerBan { serverId, userId, bannedById, reason, createdAt }` model. On ban, delete the `ServerMember` row, create a `ServerBan` row, and add an invite-join check that rejects banned users. Add a gateway IDENTIFY check: if the user has a `ServerBan` row for a server, exclude it from the READY payload and refuse gateway events for that server.

### [UPL-001] `GET /api/attachments/:id` — quarantined/blocked attachment metadata and storage key returned to channel members
- **Severity:** CRITICAL
- **File:** `apps/api/src/routes/uploads.ts:168-181`; `apps/api/src/lib/serializers.ts:147-172`
- **Issue:** The `GET /api/attachments/:id` handler performs a permission check (uploader, or channel `VIEW_CHANNEL`) but does not check `att.status`. It calls `serializeAttachment()` which returns `url: null` for non-`ready` attachments, but it still returns `storageKey`, `storageBucket`, `filename`, `mimeType`, `rejectionReason`, and `status: 'quarantined'` in the response body. A user who can view the channel can enumerate the storage key of quarantined malicious files and construct the direct storage URL themselves.
- **Impact:** Information disclosure of quarantine reason and storage paths. With the local backend, the user can attempt `GET /api/_local-files/<quarantineBucket>/<key>` — the `isSafeKey` check passes for valid keys and `resolveSafe` does allow access to the quarantine bucket (it only blocks keys that escape the bucket directory). The quarantine route check in `attachments.ts` (S3 proxy) does block `bucket === quarantineBucket`, but the local-files route has **no such bucket guard**.
- **Repro (local backend):** 1) Upload a file that ClamAV flags as malicious. 2) After scan, `GET /api/attachments/<id>` as a channel member. Observe `storageKey` in response. 3) `GET /api/_local-files/tavern-quarantine/<storageKey>` — returns the quarantined file content.
- **Fix:** In `GET /api/attachments/:id`, if `att.status` is `quarantined` or `blocked`, return 404 (or a sanitised stub without storage fields). In `registerLocalFileRoutes`, add a guard equivalent to the one in `attachments.ts`: reject requests whose `bucket` param equals the quarantine bucket name.

---

## High Findings

### [UPL-002] `sanitizeFilename()` does not strip null bytes or Windows-reserved names
- **Severity:** HIGH
- **File:** `apps/api/src/routes/uploads.ts:184-189`
- **Issue:** The function strips `\` and `/` and replaces non-alphanumeric characters with `_`, which covers most path-traversal vectors. However, it does not: (a) strip null bytes (`\0`) — a `filename` containing `\0` passes the regex, and on some OS/storage paths a null byte terminates the string early; (b) reject or rename Windows reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) as the base name; (c) strip trailing dots or spaces (Windows ignores them and they can confuse some file systems and archive extractors). The `slice(-128)` is applied correctly to cap length, and the character allowlist `[A-Za-z0-9._-]` is tight, so the risk is low on POSIX systems but meaningful on Windows-hosted deployments.
- **Impact:** On Windows hosts, a file named `NUL.png` creates an irrecoverable write operation. A filename like `file\0.exe.png` can confuse downstream tools that process the stored filename (e.g., ClamAV's file name hinting).
- **Fix:** Add `filename.replace(/\0/g, '')` before other replacements. After building the sanitized name, check if it matches `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i` and prepend `_` if so. Strip trailing dots and spaces.

### [UPL-003] MIME type vs file extension mismatch — `handout` and `file` kinds skip MIME validation
- **Severity:** HIGH
- **File:** `apps/api/src/services/upload-validator.ts:87-96`
- **Issue:** For `kind: 'handout'` and `kind: 'file'`, the validator enforces only a size limit. It applies no MIME type check and no extension check against `BLOCKED_EXTENSIONS` when `BLOCK_EXECUTABLE_UPLOADS` is `false` (the default is `true`, but operators can disable it). A user can rename `malware.exe` to `document.pdf`, set `mimeType: 'application/pdf'`, and request `kind: 'file'`. The magic-byte check in the pipeline will only match MIME types it has signatures for; PDF, ZIP, DOCX, and most "file" types are not in the `MAGIC_BYTES` array, so they pass the pipeline check with `return true`.
- **Impact:** Malicious executables are accepted as generic file uploads if the extension is not in `BLOCKED_EXTENSIONS` (e.g., `.docm`, `.xlsm`, `.hta`, `.scf`, `.psc1` are not blocked). They are stored and served as `attachment; filename="..."` to other users.
- **Fix:** For `file` and `handout` kinds, validate the extension against the blocklists unconditionally (not only when `BLOCK_EXECUTABLE_UPLOADS` is `true`). Expand `BLOCKED_EXTENSIONS` to include Office macro extensions, `.hta`, `.scf`, `.psc1`, `.inf`, `.reg`.

### [STO-001] Local-file serve route has no quarantine bucket guard
- **Severity:** HIGH
- **File:** `apps/api/src/routes/local-files.ts:82-126`
- **Issue:** `GET /api/_local-files/:bucket/:key` accepts any bucket name that passes `isSafeKey` and is a valid directory under `dataDir`. The `resolveSafe()` method allows both `mainBucket` and `quarantineBucket` names (line 196 of `local.ts`). Therefore a request to `GET /api/_local-files/tavern-quarantine/<key>` will successfully serve quarantined content. The S3-backed proxy in `attachments.ts` explicitly rejects `bucket === storage.quarantineBucket`, but the local counterpart has no equivalent guard.
- **Impact:** Any user who knows (or guesses, or enumerates via `GET /api/attachments/:id`) a quarantine storage key can download content that was flagged as malicious by ClamAV.
- **Fix:** In `registerLocalFileRoutes`, after the `isSafeKey` check, add: `if (bucket === local.quarantineBucket) { reply.status(403)...; return; }`.

### [STO-002] In-memory `PendingUpload` ticket map — no eviction on restart, unbounded growth without uploads
- **Severity:** HIGH
- **File:** `packages/media/src/storage/local.ts:52,225-230`
- **Issue:** The `tickets` map is a plain `Map<string, PendingUpload>` on the `LocalStorageBackend` instance. (a) **Restart loss:** All pending tickets are lost on process restart; any in-flight upload during a deploy restart will fail with "Unknown upload token". This is a UX issue, but because the client gets a 400 and the `Attachment` row is left in `pending` status forever with no cleanup, it can accumulate orphan rows. (b) **Eviction:** `purgeExpired()` is only called inside `presignPut()`. If an attacker or a slow client issues many `POST /api/uploads` requests without ever calling the upload URL, the `purgeExpired()` chain runs each time a new ticket is issued (so it stays bounded to active rate-limit windows), but between presign calls the map grows without bound — specifically, if the rate limit is 60 req/min and a ticket TTL is 600 s, the map can hold up to ~600 entries at any time. With concurrent clients, ULID-length map keys and `PendingUpload` objects (~100 bytes each) this is manageable, but worth noting. (c) **Replay prevention:** Tickets are single-use (deleted on `acceptUpload`), and expiry is checked. This is correct.
- **Fix:** (a) Schedule `purgeExpired()` on a periodic timer (e.g. every 60 s) in the constructor, not just on new presign calls. (b) Add a periodic job or on-upload-complete hook to delete Attachment rows stuck in `pending` status for longer than the ticket TTL. (c) Document the restart-loss behaviour in inline comments; consider persisting ticket metadata to the DB if the deployment needs zero-downtime rolling restarts.

### [PERM-003] Channel overwrite `MANAGE_ROLES` required but overwrites can grant ADMINISTRATOR to a target
- **Severity:** HIGH
- **File:** `apps/api/src/routes/overwrites.ts:44-90`
- **Issue:** `PUT /api/channels/:id/overwrites/:targetType/:targetId` requires `MANAGE_ROLES` on the channel, but does not validate the content of the `allow`/`deny` bitmasks. A user with `MANAGE_ROLES` but not `ADMINISTRATOR` can set `allow: PERMISSION_ALL` (which includes `ADMINISTRATOR`) on a user overwrite for themselves. The `computeChannelPermissions` function will then set bit 62 for that user in that channel. While this only affects channel-level permissions (the server-level `requireServerPermission` call is separate), a user who is channel-administrator gains unrestricted access to all per-channel gated operations in that channel.
- **Impact:** Channel-scoped privilege escalation: a non-admin moderator can grant themselves ADMINISTRATOR-level channel permissions.
- **Fix:** In the overwrite PUT handler, after parsing `allow`/`deny`, check that neither mask includes `Permission.ADMINISTRATOR` unless the acting user already holds `ADMINISTRATOR`. Alternatively, strip the `ADMINISTRATOR` bit from all channel overwrites before persisting.

### [PERM-004] `filterVisibleChannels` performs N sequential DB round-trips
- **Severity:** HIGH (performance/DoS)
- **File:** `apps/api/src/services/permissions-service.ts:149-165`
- **Issue:** `filterVisibleChannels` iterates each channel and calls `getChannelPermissions()` per channel, which itself issues 3-5 DB queries (server, member, @everyone role, overwrites). For a server with 50 channels, this is 150-250 queries per API call. Any endpoint that calls `filterVisibleChannels` is vulnerable to a slow-query DoS by an authenticated user fetching channel lists on a server with many channels.
- **Impact:** Server-wide starvation of the Postgres connection pool under modest load (e.g., 10 users listing channels concurrently on a 50-channel server = 1500-2500 simultaneous queries).
- **Fix:** Batch-load all relevant data (server, member, roles, overwrites for all channels) in 3-4 queries, then compute permissions in memory. This is a refactor of `loadMemberContext` + `getChannelPermissions` to accept a multi-channel context.

### [UPL-004] S3 presigned PUT — no server-side content-type or content-length enforcement
- **Severity:** HIGH
- **File:** `packages/media/src/storage/s3.ts:64-81`
- **Issue:** `presignPut` generates a presigned URL via `minio.presignedPutObject(bucket, key, expirySeconds)` without passing any conditions (bucket policy, `x-amz-content-sha256`, or a conditions object). The response advises the client to send `content-type` and `content-length` headers, but the signature itself does not enforce them. A client can PUT a different MIME type or a larger file than declared directly to S3, bypassing the validator. The pipeline's magic-byte check and ClamAV scan will catch many cases, but a file twice the declared size (or with forged MIME) lands in the main bucket until the scan runs.
- **Impact:** A user can upload a 200 MB file declared as 1 MB, bypassing the per-kind size limit at the API layer. Content reaches the main bucket before scanning.
- **Fix:** Use the minio `presignedPutObject` overload that accepts a `reqParams` map to add `Content-Type` and `Content-Length` headers to the presigned signature. Alternatively, use AWS S3 pre-signed policy conditions (`content-length-range`).

### [PERM-005] Permission overwrite does not verify `targetId` belongs to the channel's server
- **Severity:** HIGH
- **File:** `apps/api/src/routes/overwrites.ts:44-90`
- **Issue:** When `targetType === 'role'`, the route sets a `PermissionOverwrite` with `targetId` = an arbitrary role ID supplied by the client. There is no validation that the role belongs to the same server as the channel. A user with `MANAGE_ROLES` on server A can create a channel overwrite referencing a role from server B. This is mostly an integrity issue but can cause `computeChannelPermissions` to silently apply permissions for a foreign role if a user on server B is somehow also a member of server A (which can occur in multi-server setups).
- **Impact:** Cross-server role reference corruption; permissions assigned based on roles the member does not actually hold in that server.
- **Fix:** When `targetType === 'role'`, fetch the role and assert `role.serverId === channel.serverId` before upserting the overwrite.

---

## Medium Findings

### [UPL-005] Scan job not idempotent — concurrent triggers can double-process the same attachment
- **Severity:** MEDIUM
- **File:** `packages/media/src/pipeline.ts:106-117`; `apps/api/src/services/queues.ts:94-107`
- **Issue:** The Redis queue client sets `jobId: scan:<attachmentId>` which prevents duplicate jobs in the queue. However, the in-process `InMemoryQueueClient` has no deduplication: if `enqueueScan` is called twice rapidly (e.g., the HTTP timeout fires and the client retries), two `setImmediate` callbacks fire and both find `att.status === 'uploaded'`, both update to `processing`, and both proceed through the full pipeline. The pipeline status update to `processing` is not atomic with the `status === 'uploaded'` guard (no `FOR UPDATE` or `updateFirst` pattern).
- **Impact:** Double ClamAV scans, double sharp re-encodes, and a race in which the second job's `update({ status: 'ready' })` wins over the first job's quarantine action if the first was slower.
- **Fix:** Change the `status` update to use a conditional update: `UPDATE attachment SET status='processing' WHERE id=? AND status='uploaded' RETURNING id`. If no row is returned, another job already claimed it — exit early.

### [STO-003] `getPartialObject` in local backend reads the entire file into memory
- **Severity:** MEDIUM
- **File:** `packages/media/src/storage/local.ts:146-149`
- **Issue:** `getPartialObject(bucket, key, length)` calls `readFile(path)` (full file into memory) and then `buf.subarray(0, length)`. For a 200 MB video file, requesting 64 bytes of magic bytes causes a 200 MB heap allocation. With 4 concurrent worker jobs (worker concurrency = 4), that is 800 MB of RSS spike during the magic-byte check phase.
- **Fix:** Use `fs.open()` + `fileHandle.read(buffer, 0, length, 0)` to read only the required bytes from disk.

### [UPL-006] Upload `complete` endpoint — size validation uses `BigInt` equality but `stat.size` is a JS `number`
- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/uploads.ts:120-124`
- **Issue:** `stat.size` returned by `storage.statObject()` is typed as `number` (see `ObjectStat.size: number` in `types.ts`). For files larger than `Number.MAX_SAFE_INTEGER` (8192 TB), the JS number loses precision and the comparison `BigInt(stat.size) !== att.sizeBytes` could produce false-negative matches. In practice, uploads are capped at 200 MB, so this is unreachable, but the type inconsistency is a latent risk if limits are ever raised.
- **Fix:** Change `ObjectStat.size` to `bigint`, or keep it as `number` and add a comment that it is safe only for sizes below 9007199254740991 bytes.

### [PERM-006] `ADMINISTRATOR` bit is at position 62 — `Decimal(20,0)` can hold it, but only as unsigned
- **Severity:** MEDIUM
- **File:** `packages/shared/src/permissions.ts:84`; `packages/db/prisma/schema.prisma:177`
- **Issue:** `Permission.ADMINISTRATOR = 1n << 62n`. `Decimal(20, 0)` can store values up to `10^20 - 1 ≈ 1.16 × 10^20`, which is larger than `2^63 - 1 (≈ 9.22 × 10^18)` but within range of an unsigned 64-bit integer (`2^64 - 1 ≈ 1.84 × 10^19`). However, `2^62 ≈ 4.61 × 10^18` fits comfortably. `PERMISSION_ALL` (all flags OR'd) with bits 0-49 and bit 62 set equals approximately `4.61 × 10^18 + 1.13 × 10^15 ≈ 4.61 × 10^18`, well within `Decimal(20,0)`. This is safe. However, `parsePermissions` accepts hex via `BigInt(input)` and decimal strings. If a buggy client or migration script ever supplies `"0xFFFFFFFFFFFFFFFF"` (2^64-1), Postgres rejects it at the Decimal(20,0) boundary with an overflow error. The application does not have a guard that caps parsed values to the defined flag set.
- **Fix:** Add a validation in `parsePermissions` or at the overwrite/role persistence boundary to mask the input: `return parsed & PERMISSION_ALL`. This prevents any unknown high bits from being stored.

### [PERM-007] `@everyone` role can be deleted via `DELETE /api/roles/:id` — only `isEveryone` protects it
- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/roles.ts:99-116`
- **Issue:** The delete handler correctly checks `role.isEveryone` and throws a validation error. However, the server's `defaultRoleId` FK is set to `SetNull` on role delete (`schema.prisma:141`). If the `isEveryone` field is ever set incorrectly (e.g. via a direct DB migration that sets it to `false` for a row), the @everyone role can be deleted. After deletion, `loadMemberContext` returns `everyonePerms = PERMISSION_NONE` (the `defaultRoleId` is null), which means all members lose their base permissions until the server is repaired.
- **Fix:** In the delete handler, additionally check `role.id !== server.defaultRoleId` and reject. Alternatively, change the FK `onDelete` to `Restrict` so the DB refuses to delete it even if `isEveryone` is wrong.

### [UPL-007] ClamAV degradation — `ALLOW_UNSCANNED_UPLOADS` defaults to `true` in both api and worker
- **Severity:** MEDIUM
- **File:** `apps/api/src/config.ts:44`; `apps/worker/src/config.ts:18`
- **Issue:** The default value for `ALLOW_UNSCANNED_UPLOADS` is `'true'`. This means that in the common case where ClamAV is not configured (the default self-hosted deployment), all uploads bypass virus scanning and go directly to `status: 'ready'` — but only if a scanner is configured at all. Actually: re-reading `pipeline.ts` lines 128-149, when `deps.scanner === null` AND `!deps.allowUnscanned`, the pipeline rejects the upload. When `deps.scanner === null` AND `deps.allowUnscanned === true`, the pipeline skips the ClamAV step entirely and proceeds. So the default is explicitly fail-open: uploads are accepted without scanning. This is documented but not made conspicuous in the deployment guide.
- **Impact:** All uploads on a default installation are unscanned. A malicious user can upload known malware (not flagged by magic-byte or extension checks) and it will reach `status: 'ready'` and be served to other members.
- **Fix:** Change the default for `ALLOW_UNSCANNED_UPLOADS` to `'false'`. Document that operators must explicitly set it to `true` to accept unscanned uploads. Add a startup warning log when `ALLOW_UNSCANNED_UPLOADS=true` and `CLAMAV_HOST` is unset.

### [STO-004] `content-disposition` filename in local-files route leaks the internal storage key path
- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/local-files.ts:118`
- **Issue:** For non-inline files, the `content-disposition` header is `attachment; filename="<last segment of storage key>"`. The storage key format is `<userId>/<attachmentId>/<sanitizedFilename>`. The last segment is the sanitized filename, which is acceptable. However, for inline files (images, video, audio), the `content-disposition` is `inline` with no filename, and the URL itself contains the full three-segment storage key. A user observing their browser's network tab sees `<userId>/<attachmentId>/filename`, disclosing the uploader's ULID even if the uploader's profile is private.
- **Fix:** The storage key naturally embeds the uploaderID. Consider hashing or omitting it from the public URL structure. At minimum, document this as a known privacy limitation.

### [PERM-008] Moderation `lock_account` action is not atomic — gap between report.update and user.update
- **Severity:** MEDIUM
- **File:** `apps/api/src/routes/moderation.ts:98-201`
- **Issue:** The `POST /api/reports/:id/resolve` handler with `action: 'lock_account'` performs: (1) `prisma.report.update` (sets `status`), (2) `prisma.moderationAction.create`, (3) `prisma.message.updateMany` or `prisma.attachment.updateMany`, (4) `prisma.user.update` (applies the lock). These are five separate, non-transactional Prisma calls. If the process crashes between steps 1 and 4, the report is marked resolved but the user lock is never applied. Similarly, the `auditEntry` for `user.posting_locked` is written after the user update, so a crash there produces a user lock without an audit trail.
- **Fix:** Wrap the entire action sequence in `prisma.$transaction(async (tx) => { ... })`. The Prisma interactive transaction ensures all or nothing.

### [UPL-008] Worker queue has no dead-letter configuration
- **Severity:** MEDIUM
- **File:** `apps/api/src/services/queues.ts:94-107`
- **Issue:** BullMQ jobs are configured with `attempts: 3` and exponential backoff. After 3 failures the job enters BullMQ's `failed` set. The worker logs the failure but there is no dead-letter queue, no alert, and no automated re-queue. The `removeOnFail: { count: 200 }` setting means the most recent 200 failed jobs are retained for inspection, but only via the Redis CLI. There is no admin UI or API endpoint to inspect or replay failed jobs.
- **Fix:** Add a BullMQ `QueueEvents` listener that fires on `failed` after all retries are exhausted and writes an `AuditLogEntry` (action: `upload.scan_failed`). Consider setting a TTL on failed jobs (e.g. 7 days) to prevent unbounded Redis memory growth if failures accumulate.

### [PERM-009] Gateway does not check server membership at IDENTIFY — banned/kicked users can connect
- **Severity:** MEDIUM
- **File:** `apps/api/src/gateway/index.ts:168-183`; `apps/api/src/gateway/index.ts:253-271`
- **Issue:** On IDENTIFY, the gateway verifies the JWT and session validity, then calls `buildReadyPayload(userId)` which loads `serverMember` rows for the user. If a user is kicked (their `ServerMember` row deleted) after they connect, they remain connected and continue to receive events from the gateway because the `shouldDeliver` function checks current membership on each event, but the connected `client` state is not revalidated on kick/ban. More critically: a reconnect with a valid (non-expired) access token immediately after being kicked will succeed — the session is still valid, there is no server-membership check in the IDENTIFY handler beyond what `buildReadyPayload` returns (which simply returns empty servers for kicked members).
- **Impact:** A kicked user can reconnect immediately and receive zero server events (correct), but the reconnect itself is not rejected. With the `BAN_MEMBERS` enforcement gap (PERM-002), this is compounded.
- **Fix:** While not a critical gap on its own (the user gets no events after kick), adding a server-membership check at IDENTIFY for the gateway READY payload is good hygiene. The main fix is in PERM-002.

---

## Low Findings

### [PERM-010] `serializePermissions` / `permsToString` API response exposes full raw BigInt value
- **Severity:** LOW
- **File:** `apps/api/src/services/permissions-service.ts:168-170`
- **Issue:** `permsToString(p)` returns the decimal string representation of the full 64-bit BigInt, including any internal admin bits. This is by design and consistent with Discord's permission model. However, the API response for roles (`serializeRole`) includes the permissions decimal, which reveals to any member (who can list roles) whether `ADMINISTRATOR` or other sensitive flags are set on any role. This is an intentional transparency choice but worth documenting.
- **Fix:** No code change required; document that role permissions are intentionally exposed to all server members.

### [UPL-009] Magic-byte check returns `true` (passes) for MIME types with no known signature
- **Severity:** LOW
- **File:** `packages/media/src/pipeline.ts:87-98`
- **Issue:** `checkMagic` returns `true` when `candidates.length === 0`, meaning for any MIME type not in `MAGIC_BYTES` (e.g., `audio/mpeg` subtype `audio/x-wav`, `image/avif`, `audio/aac`, `audio/flac`, `video/quicktime`) the magic check is silently skipped. `image/avif` and `video/quicktime` in particular are in the allowed MIME list but have no entry in `MAGIC_BYTES`.
- **Fix:** Add magic-byte signatures for `image/avif` (ISOBMFF ftyp box: bytes 4-7 = `ftyp`, bytes 8-11 vary; use offset 4, sig `[0x66, 0x74, 0x79, 0x70]` same as MP4), `audio/aac` (`0xFF, 0xF1` or `0xFF, 0xF9`), `video/quicktime` (same ftyp approach). For types where no reliable signature exists, explicitly document the gap.

### [STO-005] Presigned S3 URL expiry is hardcoded at 600 s — no configurability
- **Severity:** LOW
- **File:** `packages/media/src/storage/s3.ts:64`, `packages/media/src/storage/local.ts:72`
- **Issue:** The default `expirySeconds = 600` (10 minutes) is reasonable, but it is not configurable via environment variable. Operators running on slow connections or with large files (200 MB video) may need longer windows.
- **Fix:** Expose `UPLOAD_URL_EXPIRY_SECONDS` in the API config and pass it to `presignPut`.

### [PERM-011] `getChannelPermissions` makes two separate queries for `server.defaultRoleId` — TOCTOU risk
- **Severity:** LOW
- **File:** `apps/api/src/services/permissions-service.ts:64-115`
- **Issue:** `loadMemberContext` fetches `server.defaultRoleId` in one query (line 21-24), and `getChannelPermissions` fetches it again in a second query (lines 82-86) to resolve the @everyone overwrite. Between these two reads, an admin could update the server's `defaultRoleId`. In practice the window is microseconds and the operation is read-only, but the double-fetch is redundant and the `everyoneRoleId` derived from the second fetch may differ from the one used in `loadMemberContext`.
- **Fix:** Return `defaultRoleId` from `loadMemberContext` and pass it to `getChannelPermissions` to eliminate the second query.

### [UPL-010] Waveform endpoint — no check that the attachment has passed scanning before accepting waveform data
- **Severity:** LOW
- **File:** `apps/api/src/routes/uploads.ts:141-166`
- **Issue:** `POST /api/attachments/:id/waveform` accepts waveform data for any `voice_message` attachment owned by the user, regardless of status (`pending`, `processing`, `quarantined`). A user can submit waveform peaks for a quarantined voice message, causing a DB write to a quarantined row. While this has no security impact (the waveform is numeric only, validated as `z.number().int().min(0).max(255)`), it is logically inconsistent.
- **Fix:** Add a check: `if (!['uploaded', 'processing', 'ready'].includes(att.status)) throw TavernError.validation('Cannot set waveform on this attachment')`.

### [STO-006] `absPath` in local backend calls `resolveSafe` which resolves symlinks — partial symlink confusion
- **Severity:** LOW
- **File:** `packages/media/src/storage/local.ts:195-223`
- **Issue:** `resolveSafe` calls `realpathSync(normalised)` to follow symlinks and then checks containment. This is the correct defence against symlink escapes. However, the fallback on line 213 (`return normalised`) returns the textual-normalised path (without symlink resolution) when the file does not yet exist. New writes therefore do not benefit from the symlink check. An attacker who can create a symlink at the target path before an upload completes could redirect the write to an arbitrary location — but only if they have OS-level write access to the data directory, which requires prior compromise.
- **Fix:** This is acceptable for the threat model (self-hosted). Document the limitation; alternatively, perform a pre-write directory existence check and resolve all parent directory symlinks before computing the target path.

### [PERM-012] Role position updates are not validated — positions can be made negative or duplicated
- **Severity:** LOW
- **File:** `apps/api/src/routes/roles.ts:59-97`
- **Issue:** `PATCH /api/roles/:id` with `body.position` accepts any integer without checking: (a) the new position is positive; (b) the new position doesn't collide with the `@everyone` role at position 0; (c) the actor's highest role is above the role being repositioned.
- **Fix:** Reject positions <= 0 (reserve 0 for @everyone). On position update, validate the actor holds a role above the target role's new position. Optionally enforce unique positions.

### [PERM-013] `computeBasePermissions` grants PERMISSION_ALL if any role has ADMINISTRATOR — no role-position guard
- **Severity:** LOW
- **File:** `packages/shared/src/permissions.ts:178-190`
- **Issue:** This is the intended Discord-style behaviour (ADMINISTRATOR on any role = full server access), and it is correct. However, combined with PERM-001 (role assignment without position guard), it means a `MANAGE_ROLES` user can assign themselves an ADMINISTRATOR role and gain full server access. This is a consequence of PERM-001 rather than an independent issue, but worth cross-referencing.
- **Fix:** Fix PERM-001.

---

## Positive Notes

- **Path-traversal defence in `isSafeKey`** (both `attachments.ts` and `local-files.ts`): The regex `^[A-Za-z0-9._\-/]+$` plus the segment-level `.`/`..` check is correct and effective on POSIX. The `resolveSafe` symlink-follow check adds a meaningful second layer.
- **SQL injection surface is zero**: All DB access goes through Prisma's parameterised query builder. No raw SQL strings were found.
- **`BigInt` used throughout permissions**: The codebase consistently uses native `BigInt` for permission math, avoiding the silent float truncation that would occur with JS `number` for bits above 52.
- **Ticket single-use enforcement in local storage**: `acceptUpload` deletes the ticket before writing to disk, correctly preventing replay of a token even on concurrent requests.
- **Quarantine is enforced in the S3 proxy**: `attachments.ts` correctly rejects requests for the quarantine bucket with a hard 403 before any S3 call is made.
- **CORS origin validation**: `parseAllowedOrigins` rejects wildcards and non-URL entries at startup, preventing accidental credential-bearing CORS opening.
- **Fastify body limit layering**: The global 2 MB body limit in `buildApp` is correctly overridden to 256 MB only on the specific upload PUT route, limiting the blast radius of large-body DoS attempts on all other endpoints.
- **File size re-validation on complete**: The `POST /api/uploads/:id/complete` handler re-stats the object and compares sizes against the declared `sizeBytes`, providing a server-side size integrity check even when the presigned PUT doesn't enforce it.
- **ClamAV timeout**: The scanner correctly applies a per-scan timeout (default 30 s) to prevent a hung ClamAV from blocking the pipeline indefinitely.
- **@everyone deletion protection**: `DELETE /api/roles/:id` checks `role.isEveryone` and rejects, preventing accidental destruction of the base permission role.
- **Token scoping on upload routes**: Upload metadata endpoints (`/waveform`, `/complete`) correctly verify `att.uploaderId === ctx.userId`, preventing one user from finalising another user's pending upload.
