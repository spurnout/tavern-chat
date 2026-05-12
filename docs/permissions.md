# Permissions

Tavern uses a Discord-style permission model: 64-bit BigInt bitsets stored as
`Decimal(20,0)` in Postgres and serialized as **strings** on the wire.

## Bit-position table

The authoritative definition lives at
[`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts).
Every bit and its decimal value is listed here so external integrations can
build permission strings without parsing TypeScript. DOC-002.

| Bit | Flag                          | Decimal             | Category    |
|----:|-------------------------------|--------------------:|-------------|
|   0 | `VIEW_CHANNEL`                |                   1 | General     |
|   1 | `SEND_MESSAGES`               |                   2 | General     |
|   2 | `READ_MESSAGE_HISTORY`        |                   4 | General     |
|   3 | `ATTACH_FILES`                |                   8 | General     |
|   4 | `EMBED_LINKS`                 |                  16 | General     |
|   5 | `ADD_REACTIONS`               |                  32 | General     |
|   6 | `USE_EXTERNAL_EMOJIS`         |                  64 | General     |
|   7 | `MENTION_EVERYONE`            |                 128 | General     |
|   8 | `MANAGE_MESSAGES`             |                 256 | General     |
|   9 | `SEND_VOICE_MESSAGES`         |                 512 | General     |
|  10 | `MANAGE_CHANNELS`             |                1024 | Server mgmt |
|  11 | `MANAGE_ROLES`                |                2048 | Server mgmt |
|  12 | `MANAGE_SERVER`               |                4096 | Server mgmt |
|  13 | `CREATE_INVITES`              |                8192 | Server mgmt |
|  14 | `MANAGE_EMOJIS`               |               16384 | Server mgmt |
|  15 | `KICK_MEMBERS`                |               32768 | Members     |
|  16 | `BAN_MEMBERS`                 |               65536 | Members     |
|  17 | `TIMEOUT_MEMBERS`             |              131072 | Members     |
|  18 | `VIEW_AUDIT_LOG`              |              262144 | Members     |
|  19 | `CONNECT_VOICE`               |              524288 | Voice       |
|  20 | `SPEAK_VOICE`                 |             1048576 | Voice       |
|  21 | `ENABLE_CAMERA`               |             2097152 | Voice       |
|  22 | `DISABLE_MEMBER_VIDEO`        |             4194304 | Voice       |
|  23 | `MUTE_MEMBERS`                |             8388608 | Voice       |
|  24 | `DEAFEN_MEMBERS`              |            16777216 | Voice       |
|  25 | `MOVE_MEMBERS`                |            33554432 | Voice       |
|  26 | `USE_VAD`                     |            67108864 | Voice       |
|  27 | `STREAM_SCREEN`               |           134217728 | Voice       |
|  28 | `CREATE_CAMPAIGNS`            |           268435456 | Tabletop    |
|  29 | `MANAGE_CAMPAIGNS`            |           536870912 | Tabletop    |
|  30 | `MANAGE_CAMPAIGN_NOTES`       |          1073741824 | Tabletop    |
|  31 | `VIEW_GM_NOTES`               |          2147483648 | Tabletop    |
|  32 | `MANAGE_HANDOUTS`             |          4294967296 | Tabletop    |
|  33 | `VIEW_PRIVATE_HANDOUTS`       |          8589934592 | Tabletop    |
|  34 | `CREATE_SESSIONS`             |         17179869184 | Tabletop    |
|  35 | `MANAGE_SESSIONS`             |         34359738368 | Tabletop    |
|  36 | `ROLL_DICE`                   |         68719476736 | Tabletop    |
|  37 | `ROLL_PRIVATE_DICE`           |        137438953472 | Tabletop    |
|  38 | `MANAGE_BOARD_GAMES`          |        274877906944 | Board games |
|  39 | `CREATE_GAME_NIGHTS`          |        549755813888 | Board games |
|  40 | `MANAGE_GAME_NIGHTS`          |       1099511627776 | Board games |
|  41 | `REPORT_CONTENT`              |       2199023255552 | T&S         |
|  42 | `VIEW_MODERATION_QUEUE`       |       4398046511104 | T&S         |
|  43 | `REVIEW_HELD_CONTENT`         |       8796093022208 | T&S         |
|  44 | `MANAGE_SERVER_SAFETY_POLICY` |      17592186044416 | T&S         |
|  45 | `MANAGE_INSTANCE_SAFETY_POLICY` |    35184372088832 | T&S         |
|  46 | `MANAGE_QUARANTINE`           |      70368744177664 | T&S         |
|  47 | `MANAGE_REPORT_WORKFLOW`      |     140737488355328 | T&S         |
|  48 | `LOCK_USER_POSTING`           |     281474976710656 | T&S         |
|  49 | `LOCK_USER_UPLOADS`           |     562949953421312 | T&S         |
|  62 | `ADMINISTRATOR`               | 4611686018427387904 | Top-level   |

`ADMINISTRATOR` short-circuits every check. Bits 50-61 are reserved.

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

## Default @everyone bundle

Fresh servers get the bundle in `PERMISSION_DEFAULT_EVERYONE`
([`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts)).
The full list, in code order (DOC-003):

| Flag                   | Why granted by default                            |
|------------------------|---------------------------------------------------|
| `VIEW_CHANNEL`         | Members can see public rooms                      |
| `SEND_MESSAGES`        | Members can chat                                  |
| `READ_MESSAGE_HISTORY` | Members can scroll back                           |
| `ATTACH_FILES`         | Members can drop in images / handouts             |
| `EMBED_LINKS`          | Pasted URLs unfurl                                |
| `ADD_REACTIONS`        | Reactions on others' messages                     |
| `USE_EXTERNAL_EMOJIS`  | Custom emojis from other servers (when allowed)   |
| `SEND_VOICE_MESSAGES`  | Voice-note attachments                            |
| `CONNECT_VOICE`        | Pull up a chair in a voice room                   |
| `SPEAK_VOICE`          | Unmute mic                                        |
| `ENABLE_CAMERA`        | Turn on camera                                    |
| `STREAM_SCREEN`        | Share screen                                      |
| `USE_VAD`              | Voice-activity detection (no push-to-talk)        |
| `ROLL_DICE`            | Public dice rolls in chat                         |
| `REPORT_CONTENT`       | File moderation reports                           |

Notable omissions from defaults: `MANAGE_*`, `KICK/BAN/TIMEOUT_MEMBERS`,
`VIEW_AUDIT_LOG`, `DISABLE_MEMBER_VIDEO`, `MUTE/DEAFEN/MOVE_MEMBERS`,
`MENTION_EVERYONE`, `MANAGE_MESSAGES`, GM-only tabletop rights, all of T&S
moderation, and `ADMINISTRATOR`.

Pre-existing servers don't inherit a constant change for free: when the bundle
expands, a one-shot SQL migration ORs the new bit into every `@everyone` role.
See `packages/db/prisma/migrations/20260511181830_default_screen_share/migration.sql`
for the pattern.

## Role hierarchy enforcement

Beyond the bit-level allow/deny, role mutations and member-role assignments
also enforce a **role hierarchy** check (PERM-001):

1. An actor cannot manage a role whose `position` is at or above their own
   highest role.
2. An actor cannot grant a role that carries permission bits the actor does
   not themselves hold.

Server owners are exempt from both checks. The same rules extend to channel
permission overwrites (PERM-003): an overwrite cannot `allow` bits the actor
doesn't have at the server scope.

## Banning

`BAN_MEMBERS` is now enforced (PERM-002). See [docs/safety.md](safety.md) and
the `ban-service` module for the lifecycle: a row in `ServerBan` blocks the
banned user from reconnecting via the gateway and from redeeming any
server-scoped invite to rejoin. Force-disconnect happens via the
`GUILD_BAN_ADD` dispatch event.
