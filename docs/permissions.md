# Permissions

Tavern uses a Discord-style permission model: 64-bit BigInt bitsets stored as
`Decimal(20,0)` in Postgres and serialized as **strings** on the wire.

## Flags

The full enum lives at [`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts).

Key categories:

- General chat: `VIEW_CHANNEL`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`,
  `ATTACH_FILES`, `EMBED_LINKS`, `ADD_REACTIONS`, `USE_EXTERNAL_EMOJIS`,
  `MENTION_EVERYONE`, `MANAGE_MESSAGES`, `SEND_VOICE_MESSAGES`.
- Server / channel mgmt: `MANAGE_CHANNELS`, `MANAGE_ROLES`, `MANAGE_SERVER`,
  `CREATE_INVITES`, `MANAGE_EMOJIS`.
- Members: `KICK_MEMBERS`, `BAN_MEMBERS`, `TIMEOUT_MEMBERS`, `VIEW_AUDIT_LOG`.
- Voice/video: `CONNECT_VOICE`, `SPEAK_VOICE`, `ENABLE_CAMERA`,
  `DISABLE_MEMBER_VIDEO`, `MUTE_MEMBERS`, `DEAFEN_MEMBERS`, `MOVE_MEMBERS`,
  `USE_VAD`, `STREAM_SCREEN`.
- Tabletop: `CREATE_CAMPAIGNS`, `MANAGE_CAMPAIGNS`, `MANAGE_CAMPAIGN_NOTES`,
  `VIEW_GM_NOTES`, `MANAGE_HANDOUTS`, `VIEW_PRIVATE_HANDOUTS`,
  `CREATE_SESSIONS`, `MANAGE_SESSIONS`, `ROLL_DICE`, `ROLL_PRIVATE_DICE`.
- Board games: `MANAGE_BOARD_GAMES`, `CREATE_GAME_NIGHTS`, `MANAGE_GAME_NIGHTS`.
- Trust & safety: `REPORT_CONTENT`, `VIEW_MODERATION_QUEUE`,
  `REVIEW_HELD_CONTENT`, `MANAGE_SERVER_SAFETY_POLICY`,
  `MANAGE_INSTANCE_SAFETY_POLICY`, `MANAGE_QUARANTINE`,
  `MANAGE_REPORT_WORKFLOW`, `LOCK_USER_POSTING`, `LOCK_USER_UPLOADS`.
- `ADMINISTRATOR` — short-circuits everything.

## Resolution

Given a member, a channel, and the role overwrites attached to that channel:

1. **If the user is the server owner**, return `PERMISSION_ALL`.
2. Compute base permissions = `@everyone` ∪ assigned-role permissions.
3. **If `ADMINISTRATOR` is set**, return `PERMISSION_ALL`.
4. Apply the channel's `@everyone` overwrite: `(perms & ~deny) | allow`.
5. Combine all role overwrites into a single deny + allow, apply the same way.
6. Apply the member-specific overwrite last (most specific).

The reference implementation is `computeChannelPermissions` in
[`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts),
covered by the test suite in
[`packages/shared/test/permissions.test.ts`](../packages/shared/test/permissions.test.ts).

## Hidden channels

A channel is "hidden" for a member when their resolved channel permissions do
not include `VIEW_CHANNEL`. Hidden channels:

- **Are never listed** in `GET /servers/:id/channels` for that member.
- **Are never** the source of dispatched gateway events to that member.
- **Cannot** be the target of any other API operation. Attempts return
  `CHANNEL_HIDDEN` with HTTP 404 — we deliberately do not distinguish hidden
  from missing to avoid leaking existence.

## Wire format

In JSON, permissions are decimal strings. Example:

```json
{
  "id": "01J9...",
  "name": "@everyone",
  "permissions": "1099511627775"
}
```

Hex (`"0x..."`) is also accepted by the API; decimal is canonical.
