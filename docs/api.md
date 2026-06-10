# API reference

All routes are prefixed `/api`. All request and response bodies are JSON unless
otherwise noted. Path params are written `:name` here even when the route file
declares them as `:id` / `:serverId` etc. — the underlying Fastify route still
expects the literal param name.

## Envelopes

Every response uses one of these two shapes:

```json
{ "ok": true, "data": { ... } }
```

```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have permission.",
    "details": null
  }
}
```

Error codes are enumerated in [`packages/shared/src/errors.ts`](../packages/shared/src/errors.ts).
Notable codes added by the security review:

| Code | When |
|------|------|
| `ROLE_HIERARCHY` | Actor tried to manage a role at or above their own, or grant permissions they don't hold. |
| `MEMBER_BANNED` | Banned user attempted to rejoin a server. |
| `BUFFER_GAP` | (gateway) `RESUME` lastSeq is older than the buffer floor; client must `IDENTIFY` fresh. |

## Authentication

The API accepts a bearer access token in `Authorization: Bearer <jwt>`. The
refresh token rides on an `httpOnly`, `Secure`, `SameSite=Strict` cookie
named `tv_refresh`, scoped to `/api/auth`. The SPA holds the access token in
memory only; the cookie is the only place the refresh token lives on the
client (SEC-001 / FE-02).

JWT claims: HS256-signed, `iss=tavern`, `aud=tavern-api` (access) or
`aud=tavern-refresh` (refresh) (SEC-005). Access TTL = 15 min, refresh TTL =
30 days; both configurable via `ACCESS_TOKEN_TTL_SECONDS` /
`REFRESH_TOKEN_TTL_SECONDS`.

### Auth routes (`apps/api/src/routes/auth.ts`)

| Method | Path | Rate limit | Notes |
|--------|------|------------|-------|
| GET    | `/auth/bootstrap-status` | 30/min | True only while `User.count = 0`. Unauthenticated. |
| POST   | `/auth/bootstrap` | 5 / 5 min | First-run admin creation. 409 once any user exists. |
| POST   | `/auth/register` | 10/min | Invite-only. Atomic invite consume (SEC-002). Instance invites create an account; server invites create an account and server membership. Sets `tv_refresh` cookie. |
| POST   | `/auth/login` | 10/min | Username or email + password. Failed-attempt counter (SEC-006) locks for 15 min after 10. Sets `tv_refresh` cookie. |
| POST   | `/auth/refresh` | 20/min | Reads `tv_refresh` cookie (or body `refreshToken` for deprecation runway). Rotates: replay of the old token revokes the session. Sets a fresh cookie. |
| POST   | `/auth/logout` | n/a (authenticated) | Revokes the calling session; clears the cookie. |
| PATCH  | `/auth/password` | 5 / 5 min | Body: `{ currentPassword, newPassword }`. Verifies the old password, rotates the Argon2 hash, **revokes every active session for the user including this one** (SEC-003). |
| GET    | `/auth/me` | n/a | Returns the authenticated user profile. |

## Servers (`apps/api/src/routes/servers.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| GET    | `/servers` | (your servers) |
| POST   | `/servers` | (any user) |
| GET    | `/servers/:id` | server member |
| PATCH  | `/servers/:id` | `MANAGE_SERVER` |
| DELETE | `/servers/:id` | server owner |
| GET    | `/servers/:id/members` | server member |
| GET    | `/servers/:id/permissions/me` | server member; returns the caller's bitset |
| GET    | `/servers/:id/roles` | server member |
| GET    | `/servers/:id/channels` | server member; hidden channels filtered |
| PATCH  | `/servers/:serverId/members/:userId` | self or `MANAGE_NICKNAMES`; body `{ nickname: string \| null }`; broadcasts `MEMBER_UPDATE` |

## Channels (`apps/api/src/routes/channels.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| POST   | `/servers/:serverId/channels` | `MANAGE_CHANNELS` |
| GET    | `/channels/:id` | `VIEW_CHANNEL` |
| PATCH  | `/channels/:id` | `MANAGE_CHANNELS` |
| DELETE | `/channels/:id` | `MANAGE_CHANNELS` |

## Messages (`apps/api/src/routes/messages.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| GET    | `/channels/:id/messages?before=<id>&after=<id>&limit=50` | `READ_MESSAGE_HISTORY` |
| POST   | `/channels/:id/messages` | `SEND_MESSAGES` + (`ATTACH_FILES` if attaching) |
| PATCH  | `/messages/:id` | author only |
| DELETE | `/messages/:id` | author OR `MANAGE_MESSAGES` |

`POST /channels/:id/messages` supports an optional `nonce` for idempotent
retries. The unique-by-`(channelId, nonce)` partial index plus the 24-hour
worker sweep (DB-010) means nonces can be reused after a day.

## Reactions (`apps/api/src/routes/reactions.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| PUT    | `/messages/:id/reactions/:emoji` | `ADD_REACTIONS` |
| DELETE | `/messages/:id/reactions/:emoji` | (own reaction) |

`:emoji` is URL-encoded. Custom emojis use the form `custom:<emojiId>`.

## Roles (`apps/api/src/routes/roles.ts`)

Every mutating route below enforces the role-hierarchy guard added in PERM-001:
the actor cannot manage a role at or above their own highest role, and cannot
grant permissions the actor doesn't themselves hold.

| Method | Path | Required permission |
|--------|------|---------------------|
| POST   | `/servers/:serverId/roles` | `MANAGE_ROLES` + hierarchy |
| PATCH  | `/roles/:id` | `MANAGE_ROLES` + hierarchy |
| DELETE | `/roles/:id` | `MANAGE_ROLES`; refuses to delete `@everyone` |
| PUT    | `/servers/:serverId/members/:userId/roles` | `MANAGE_ROLES` + hierarchy |

## Permission overwrites (`apps/api/src/routes/overwrites.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| GET    | `/channels/:id/overwrites` | `VIEW_CHANNEL` |
| PUT    | `/channels/:id/overwrites/:targetType/:targetId` | `MANAGE_ROLES` + actor must hold every bit they're trying to allow (PERM-003) + target must belong to the channel's server (PERM-005) |
| DELETE | `/channels/:id/overwrites/:targetType/:targetId` | `MANAGE_ROLES` |

## Bans (`apps/api/src/routes/bans.ts`, PERM-002)

A row in `ServerBan` hard-blocks the user from a server: the gateway IDENTIFY
filter excludes them from READY, and an active session for the user is
force-closed with WS code 4403 on a `GUILD_BAN_ADD` dispatch.

| Method | Path | Required permission |
|--------|------|---------------------|
| GET    | `/servers/:serverId/bans` | `BAN_MEMBERS` |
| POST   | `/servers/:serverId/bans` | `BAN_MEMBERS` + role-hierarchy check; cannot ban the owner |
| DELETE | `/servers/:serverId/bans/:userId` | `BAN_MEMBERS` |

`POST` body: `{ userId, reason?, expiresAt? }`. `expiresAt` must be in the
future; `null` = permanent.

## Invites (`apps/api/src/routes/invites.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| POST   | `/invites` | `CREATE_INVITES` (server-scoped) or instance admin (instance-scoped) |
| DELETE | `/invites/:id` | invite creator or `MANAGE_SERVER` |
| POST   | `/invites/:code/join` | authenticated; refuses if user is banned from the target server |

`POST /invites/:code/join` returns `{ serverId: string \| null }`. For a
server-scoped invite, `serverId` is the joined server. For an
instance-scoped invite — which is a registration ticket, not a join target —
an already-authenticated caller gets `{ serverId: null }` as a no-op
acknowledgement (no `uses` increment, no audit, no membership change). Clients
should treat `null` as "you're already on this instance, go home."

## Uploads & attachments

Tavern uses presigned PUTs against either S3 (Garage) or a token-validated
local-storage route, depending on `STORAGE_BACKEND`. When any voice room has
2+ active participants, `POST /uploads` returns `strategy:
"tavern_throttled"` and a Tavern-controlled upload URL instead of a direct S3
presign, so the API can serialize and byte-throttle attachment uploads before
they compete with voice traffic.

### Upload pipeline (`apps/api/src/routes/uploads.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| POST   | `/uploads` | `ATTACH_FILES` (or `SEND_VOICE_MESSAGES` for voice-message kind) |
| POST   | `/uploads/:id/complete` | uploader only |
| POST   | `/attachments/:id/waveform` | uploader only; voice-message kind only |
| GET    | `/attachments/:id` | viewer of the channel; quarantined/blocked attachments return 404 to non-owners (UPL-001) |

Upload responses include `upload.strategy` (`direct` or
`tavern_throttled`), `upload.voiceActive`, and, for throttled uploads,
`upload.maxBytesPerSecond`. Defaults are `VOICE_ACTIVE_UPLOAD_THROTTLE_*`
env vars: one active upload, 256 KiB/s sustained, 512 KiB burst.

`POST /uploads` validates the declared extension against a blocklist
(`BLOCKED_EXTENSIONS`, `BLOCKED_ARCHIVE_EXTENSIONS`), rejects SVG outright,
and runs a per-kind MIME and size check (UPL-003 MIME-vs-extension
allow-list for `handout`/`file`). Filename is sanitised via the UPL-002
hardening (NFC normalize, strip null bytes, strip Windows-reserved names,
strip leading/trailing dots).

### Object proxy routes

Voice-aware throttled uploads (`apps/api/src/routes/governed-uploads.ts`,
storage-backend independent):

| Method | Path |
|--------|------|
| PUT    | `/_governed-uploads/:token` |

`STORAGE_BACKEND=s3` (`apps/api/src/routes/attachments.ts`):

| Method | Path |
|--------|------|
| GET    | `/_attachments/:bucket/:key` |

The route streams from the S3 client. Reads on the quarantine bucket are
hard-403 (STO-001 / UPL-001). `Content-Disposition` strips the storage-key
path so the on-disk layout doesn't leak (STO-004).

`STORAGE_BACKEND=local` (`apps/api/src/routes/local-files.ts`):

| Method | Path |
|--------|------|
| PUT    | `/_local-uploads/:token` (consumes a presign) |
| GET    | `/_local-files/:bucket/:key` |

Same quarantine-bucket guard (STO-001). `_local-uploads` also checks the
voice-aware upload governor at PUT time, so local tickets issued before a
voice room becomes active are throttled when they start sending bytes.

## Voice / video (`apps/api/src/routes/voice.ts`)

| Method | Path | Rate limit | Notes |
|--------|------|------------|-------|
| POST   | `/voice/join` | n/a | Mints a LiveKit token with publish sources gated by `SPEAK_VOICE`, `ENABLE_CAMERA`, `STREAM_SCREEN`. Returns `liveKitUrl`, `token`, `roomName`, `allowedFeatures`, `expiresAt`. TTL is 15 minutes; the client refreshes on a 5-minute lead so each session rotates tokens every ~10 minutes. |
| POST   | `/voice/refresh-token` | 30/min | Re-mints a token for an in-progress session before the 15-minute TTL (VC-001). Re-checks live permissions, so a role demote narrows the new token. |
| POST   | `/voice/leave` | 30/min | Batched `updateMany` across the caller's voice states (RT-008); broadcasts `VOICE_STATE_UPDATE` with the previous `channelId` so per-channel permission filter applies (RT-001). |
| POST   | `/voice/state` | 60/min | Partial state: `{ channelId, screenSharing?, cameraOn?, selfMute?, selfDeaf? }`. 409 `VOICE_STATE_STALE` if caller isn't currently in `channelId`. Re-checks publish permissions live. |

## Tabletop

### Campaigns (`apps/api/src/routes/campaigns.ts`)

| Method | Path |
|--------|------|
| GET    | `/servers/:serverId/campaigns` |
| POST   | `/servers/:serverId/campaigns` |
| GET    | `/campaigns/:id` |
| PATCH  | `/campaigns/:id` |

### Sessions (`apps/api/src/routes/sessions.ts`)

| Method | Path |
|--------|------|
| GET    | `/campaigns/:id/sessions` |
| POST   | `/sessions` |
| PATCH  | `/sessions/:id` |
| PUT    | `/sessions/:id/rsvp` |

### Notes (`apps/api/src/routes/notes.ts`)

| Method | Path |
|--------|------|
| GET    | `/campaigns/:id/notes` |
| POST   | `/notes` |
| PATCH  | `/notes/:id` |
| DELETE | `/notes/:id` |

### Handouts (`apps/api/src/routes/handouts.ts`)

| Method | Path |
|--------|------|
| GET    | `/campaigns/:id/handouts` |
| POST   | `/handouts` |
| PATCH  | `/handouts/:id` |

### Dice (`apps/api/src/routes/dice.ts`)

| Method | Path |
|--------|------|
| POST   | `/dice/roll` |
| GET    | `/channels/:id/dice` |

## Board games (`apps/api/src/routes/board-games.ts`)

| Method | Path |
|--------|------|
| GET    | `/servers/:serverId/board-games` |
| POST   | `/servers/:serverId/board-games` |
| PATCH  | `/board-games/:id` |
| DELETE | `/board-games/:id` |

## Game nights (`apps/api/src/routes/game-nights.ts`)

| Method | Path |
|--------|------|
| GET    | `/servers/:serverId/game-nights` |
| POST   | `/servers/:serverId/game-nights` |
| PATCH  | `/game-nights/:id` |
| GET    | `/game-nights/:id/candidates` |
| POST   | `/game-nights/:id/candidates` |
| POST   | `/game-nights/:id/votes` |
| PUT    | `/game-nights/:id/rsvp` |

## Custom emojis (`apps/api/src/routes/emojis.ts`)

| Method | Path |
|--------|------|
| GET    | `/servers/:serverId/emojis` |
| POST   | `/servers/:serverId/emojis` |
| DELETE | `/emojis/:id` |

## Search (`apps/api/src/routes/search.ts`)

| Method | Path |
|--------|------|
| GET    | `/servers/:serverId/search?q=<term>&limit=20` |

Backed by the `pg_trgm` GIN index on `Message.content` (DB-003). Hidden channels
are filtered before the search runs so they never appear in results.

## Typing (`apps/api/src/routes/typing.ts`)

| Method | Path | Rate limit |
|--------|------|------------|
| POST   | `/channels/:id/typing` | 30/min (one ping per ~3 s in practice) |

## Moderation (`apps/api/src/routes/moderation.ts`)

| Method | Path | Required permission |
|--------|------|---------------------|
| POST   | `/reports` | `REPORT_CONTENT` |
| GET    | `/servers/:serverId/moderation/queue` | `VIEW_MODERATION_QUEUE` |
| POST   | `/reports/:id/resolve` | `MANAGE_REPORT_WORKFLOW` |
| GET    | `/servers/:serverId/audit-log` | `VIEW_AUDIT_LOG` |
| GET    | `/servers/:serverId/safety-policy` | server member |
| PATCH  | `/servers/:serverId/safety-policy` | `MANAGE_SERVER_SAFETY_POLICY` |

## Direct messages (`apps/api/src/routes/dms.ts`)

DM permissions reduce to "are you a member of this `DmChannel`?". Starting
a DM additionally requires that the two users share at least one server —
no DMing strangers from outside the instance.

`(kind = 'direct', pairKey)` is enforced UNIQUE in PostgreSQL (`pairKey` is
the sorted `userIdA:userIdB` of the two members), so concurrent calls to
`POST /api/dms/direct` for the same pair return the same channel id.

| Method | Path | Rate limit | Notes |
|--------|------|------------|-------|
| GET    | `/dms` | n/a | List my DM channels, sorted by `lastMessageAt` desc. |
| GET    | `/dms/candidates` | n/a | Users I share at least one server with — the eligible pool for starting a new DM. Single query; replaces the older client-side fan-out across `/servers/:id/members`. |
| POST   | `/dms/direct` | 30/min | `{ userId }` — open or reuse a 1:1 DM with another user (must share a server). |
| POST   | `/dms/group` | 10/min | `{ userIds, name? }` — create a group DM. Capped at 10 members (creator + 9). |
| GET    | `/dms/:id` | DM member | |
| PATCH  | `/dms/:id` | DM member, group only | `{ name }`; direct DMs cannot be renamed. |
| POST   | `/dms/:id/read` | DM member | `{ at? }` — update my `lastReadAt` watermark. |
| GET    | `/dms/:id/messages?before=<id>&after=<id>&limit=50` | DM member | |
| POST   | `/dms/:id/messages` | DM member | Same content/attachment/reply/`nonce` shape as server messages; voice messages aren't supported in DMs (yet). Broadcasts `DM_MESSAGE_CREATE`. |

## Presence (`apps/api/src/routes/presence.ts`)

Presence is derived from two inputs: client-reported activity (idle timer)
and the sticky `manualDnd` flag on the user row. The gateway maintains the
"socket count" in-memory; when it drops to zero the user flips to `offline`.

| Method | Path | Rate limit | Notes |
|--------|------|------------|-------|
| GET    | `/me/presence` | n/a | `{ presence, manualDnd }`. Mainly useful at app boot; subsequent updates arrive via `PRESENCE_UPDATE` gateway dispatches. |
| PATCH  | `/me/presence` | 60/min | `{ active?: boolean, dnd?: boolean }`. `active` toggles idle/active; `dnd` flips the sticky override. |

`PRESENCE_UPDATE` dispatches are scoped to peers who share at least one
server or DM channel with the target, plus the target themselves — not a
global broadcast.

## User profiles (`apps/api/src/routes/users.ts`)

Powers the Discord-style member profile card. Sidebar rows in
`GET /servers/:id/members` stay lean; the popover lazily fetches the rich
profile on first open.

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/users/:userId/profile` | Self-fetch is always allowed; otherwise viewer and target must share a server. 404s rather than 403s on no-share so we don't disclose existence. |
| PATCH  | `/users/me/profile` | PATCH semantics over `displayName`, `bio`, `avatarAttachmentId`, `pronouns`, `accentColor`, `timezone`, `customStatus`, `customStatusExpiresAt`, `socialLinks`. Social-link URLs are restricted to `http://`, `https://`, and `mailto:` (any other scheme is rejected by the schema). Broadcasts a partial `MEMBER_UPDATE` per shared server. |

## Notification preferences (`apps/api/src/routes/notifications.ts`)

User-global preferences (sounds, volume, focus / voice-room gating) and
per-server overrides (mute messages / mentions / everything). Defaults are
applied on first read.

| Method | Path | Rate limit | Notes |
|--------|------|------------|-------|
| GET    | `/me/notification-preferences` | n/a | User-global prefs; created lazily on first read. |
| PATCH  | `/me/notification-preferences` | 30/min | Partial update over `soundEnabled`, `volume`, `chatSoundsWhileInVoice`, `playOnlyWhenUnfocused`, `mentionsOverrideMute`. |
| GET    | `/servers/:serverId/notification-preferences/me` | server member | Per-tavern override row for the caller. |
| PATCH  | `/servers/:serverId/notification-preferences/me` | 30/min | Partial update over `muteAll`, `muteMessages`, `muteMentions`. |

## Misc

| Method | Path | Notes |
|--------|------|-------|
| GET    | `/healthz` | Always 200 once the API is accepting requests. No auth. |
| GET    | `/api/instance` | Public instance metadata: name, feature flags (`registrationOpen`, `trustSafetyCoreEnabled`, etc.). |

## Rate limit headers

Every rate-limited route returns `RateLimit-Limit`, `RateLimit-Remaining`, and
`RateLimit-Reset` headers per the @fastify/rate-limit plugin. A 429 response
also carries `Retry-After`.

## Pagination

Cursor-based; query params: `before=<ulid>`, `after=<ulid>`, `limit=N` (max 50
on message list, 30 on game-night candidates). The compound
`Message(channelId, id)` index (DB-021) supports the page-by-ulid pattern.

## Gateway

WebSocket endpoint: `wss://<host>/gateway`

See [`packages/shared/src/schemas/gateway.ts`](../packages/shared/src/schemas/gateway.ts)
for opcodes and event names. Lifecycle: `HELLO` → `IDENTIFY` → `READY`,
followed by a `HEARTBEAT`/`HEARTBEAT_ACK` loop with `DISPATCH` events.

`RESUME` with a `lastSeq` newer than the gateway's `bufferFloor` replays the
buffered window (RT-010); older `lastSeq` returns `INVALID_SESSION` with
reason `BUFFER_GAP` (RT-003). Banned users are disconnected via a targeted
`GUILD_BAN_ADD` followed by a 4403 close (PERM-002). The gateway closes
slow consumers above ~1 MiB of `bufferedAmount` with code 1009 (RT-002).
