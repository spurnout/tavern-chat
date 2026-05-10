# API reference

All routes are prefixed `/api`. All bodies are JSON.

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

## Auth

| Method | Path | Notes |
|--------|------|-------|
| POST | `/auth/register` | Invite-only; returns access + refresh tokens. |
| POST | `/auth/login` | Identifier (username **or** email) + password. |
| POST | `/auth/refresh` | Rotates refresh tokens; reuse triggers session revocation. |
| POST | `/auth/logout` | Requires bearer token. Revokes the calling session. |
| GET  | `/auth/me` | Returns the authenticated user. |

Tokens are HS256 JWTs. Access TTL = 15 min, refresh TTL = 30 days, both
configurable via env vars.

## Servers / channels / messages (Phase 1)

| Method | Path |
|--------|------|
| GET    | `/servers` (mine) |
| POST   | `/servers` |
| GET    | `/servers/:id` |
| PATCH  | `/servers/:id` |
| DELETE | `/servers/:id` |
| GET    | `/servers/:id/channels` |
| POST   | `/servers/:id/channels` |
| PATCH  | `/channels/:id` |
| DELETE | `/channels/:id` |
| GET    | `/channels/:id/messages?before=<id>&limit=50` |
| POST   | `/channels/:id/messages` |
| PATCH  | `/messages/:id` |
| DELETE | `/messages/:id` |

## Roles & overwrites (Phase 2)

| Method | Path |
|--------|------|
| GET    | `/servers/:id/roles` |
| POST   | `/servers/:id/roles` |
| PATCH  | `/roles/:id` |
| DELETE | `/roles/:id` |
| PUT    | `/members/:userId/roles` |
| GET    | `/channels/:id/overwrites` |
| PUT    | `/channels/:id/overwrites/:targetType/:targetId` |
| DELETE | `/channels/:id/overwrites/:targetType/:targetId` |

## Uploads & attachments (Phase 2/3)

| Method | Path |
|--------|------|
| POST   | `/uploads` (request presigned PUT URL) |
| POST   | `/uploads/:id/complete` |
| GET    | `/attachments/:id` |

## Voice / video (Phase 3)

| Method | Path |
|--------|------|
| POST   | `/voice/join` |
| POST   | `/voice/leave` |

## Tabletop (Phase 4)

| Method | Path |
|--------|------|
| GET    | `/servers/:id/campaigns` |
| POST   | `/campaigns` |
| GET    | `/campaigns/:id` |
| PATCH  | `/campaigns/:id` |
| GET    | `/campaigns/:id/sessions` |
| POST   | `/campaigns/:id/sessions` |
| PATCH  | `/sessions/:id` |
| PUT    | `/sessions/:id/rsvp` |
| GET    | `/campaigns/:id/notes` |
| POST   | `/campaigns/:id/notes` |
| GET    | `/campaigns/:id/handouts` |
| POST   | `/campaigns/:id/handouts` |
| POST   | `/dice/roll` |

## Board games (Phase 5)

| Method | Path |
|--------|------|
| GET    | `/servers/:id/board-games` |
| POST   | `/servers/:id/board-games` |
| PATCH  | `/board-games/:id` |
| GET    | `/servers/:id/game-nights` |
| POST   | `/servers/:id/game-nights` |
| POST   | `/game-nights/:id/candidates` |
| POST   | `/game-nights/:id/votes` |
| PUT    | `/game-nights/:id/rsvp` |

## Moderation & audit (Phase 2)

| Method | Path |
|--------|------|
| POST   | `/reports` |
| GET    | `/servers/:id/moderation/queue` |
| POST   | `/reports/:id/resolve` |
| GET    | `/servers/:id/audit-log` |
| GET    | `/servers/:id/safety-policy` |
| PATCH  | `/servers/:id/safety-policy` |

## Gateway

WebSocket endpoint: `wss://<host>/gateway`

See [`packages/shared/src/schemas/gateway.ts`](../packages/shared/src/schemas/gateway.ts)
for opcodes and event names. The lifecycle is HELLO → IDENTIFY → READY →
HEARTBEAT/HEARTBEAT_ACK loop with DISPATCH events in between.
