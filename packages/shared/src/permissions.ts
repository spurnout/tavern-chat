/**
 * Tavern permission system.
 *
 * Permissions are stored as 64-bit BigInt bitsets. Because JSON cannot represent
 * BigInt natively, all serialization to/from API uses string form ("0x...", or
 * decimal). On the wire and in the DB, permissions are strings; in memory we
 * use BigInt.
 *
 * Resolution rules (Discord-style):
 *   1. Server owner OR ADMINISTRATOR -> all permissions allowed.
 *   2. Base = @everyone role permissions.
 *   3. Apply additional role permissions (OR).
 *   4. Apply @everyone channel overwrite (deny first, then allow).
 *   5. Apply role channel overwrites (combined deny first, then combined allow).
 *   6. Apply user channel overwrite (deny first, then allow).
 */

export const Permission = {
  // -- General / chat ----------------------------------------------------
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  READ_MESSAGE_HISTORY: 1n << 2n,
  ATTACH_FILES: 1n << 3n,
  EMBED_LINKS: 1n << 4n,
  ADD_REACTIONS: 1n << 5n,
  USE_EXTERNAL_EMOJIS: 1n << 6n,
  MENTION_EVERYONE: 1n << 7n,
  MANAGE_MESSAGES: 1n << 8n,
  SEND_VOICE_MESSAGES: 1n << 9n,

  // -- Server / channel management ---------------------------------------
  MANAGE_CHANNELS: 1n << 10n,
  MANAGE_ROLES: 1n << 11n,
  MANAGE_SERVER: 1n << 12n,
  CREATE_INVITES: 1n << 13n,
  MANAGE_EMOJIS: 1n << 14n,

  // -- Members ------------------------------------------------------------
  KICK_MEMBERS: 1n << 15n,
  BAN_MEMBERS: 1n << 16n,
  TIMEOUT_MEMBERS: 1n << 17n,
  VIEW_AUDIT_LOG: 1n << 18n,

  // -- Voice / video ------------------------------------------------------
  CONNECT_VOICE: 1n << 19n,
  SPEAK_VOICE: 1n << 20n,
  ENABLE_CAMERA: 1n << 21n,
  DISABLE_MEMBER_VIDEO: 1n << 22n,
  MUTE_MEMBERS: 1n << 23n,
  DEAFEN_MEMBERS: 1n << 24n,
  MOVE_MEMBERS: 1n << 25n,
  USE_VAD: 1n << 26n,
  STREAM_SCREEN: 1n << 27n,

  // -- Tabletop / RPG -----------------------------------------------------
  CREATE_CAMPAIGNS: 1n << 28n,
  MANAGE_CAMPAIGNS: 1n << 29n,
  MANAGE_CAMPAIGN_NOTES: 1n << 30n,
  VIEW_GM_NOTES: 1n << 31n,
  MANAGE_HANDOUTS: 1n << 32n,
  VIEW_PRIVATE_HANDOUTS: 1n << 33n,
  CREATE_SESSIONS: 1n << 34n,
  MANAGE_SESSIONS: 1n << 35n,
  ROLL_DICE: 1n << 36n,
  ROLL_PRIVATE_DICE: 1n << 37n,

  // -- Board games --------------------------------------------------------
  MANAGE_BOARD_GAMES: 1n << 38n,
  CREATE_GAME_NIGHTS: 1n << 39n,
  MANAGE_GAME_NIGHTS: 1n << 40n,

  // -- Trust & safety -----------------------------------------------------
  REPORT_CONTENT: 1n << 41n,
  VIEW_MODERATION_QUEUE: 1n << 42n,
  REVIEW_HELD_CONTENT: 1n << 43n,
  MANAGE_SERVER_SAFETY_POLICY: 1n << 44n,
  MANAGE_INSTANCE_SAFETY_POLICY: 1n << 45n,
  MANAGE_QUARANTINE: 1n << 46n,
  MANAGE_REPORT_WORKFLOW: 1n << 47n,
  LOCK_USER_POSTING: 1n << 48n,
  LOCK_USER_UPLOADS: 1n << 49n,

  // -- Top-level ----------------------------------------------------------
  ADMINISTRATOR: 1n << 62n,
} as const;

export type PermissionFlag = keyof typeof Permission;

export const PermissionFlags = Object.keys(Permission) as PermissionFlag[];

/** No permissions. */
export const PERMISSION_NONE = 0n;

/** All permissions OR'd together. */
export const PERMISSION_ALL: bigint = PermissionFlags.reduce(
  (acc, flag) => acc | Permission[flag],
  0n,
);

/** Default @everyone role on a fresh server: minimal civic rights. */
export const PERMISSION_DEFAULT_EVERYONE: bigint =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.ATTACH_FILES |
  Permission.EMBED_LINKS |
  Permission.ADD_REACTIONS |
  Permission.USE_EXTERNAL_EMOJIS |
  Permission.SEND_VOICE_MESSAGES |
  Permission.CONNECT_VOICE |
  Permission.SPEAK_VOICE |
  Permission.ENABLE_CAMERA |
  Permission.STREAM_SCREEN |
  Permission.USE_VAD |
  Permission.ROLL_DICE |
  Permission.REPORT_CONTENT;

// ---- Serialization ---------------------------------------------------------

/** Serialize a BigInt permission set to a decimal string. */
export function serializePermissions(perms: bigint): string {
  return perms.toString();
}

/** Parse a permissions string (decimal or "0x"-prefixed hex) into a BigInt. */
export function parsePermissions(input: string | bigint | null | undefined): bigint {
  if (input === null || input === undefined) return 0n;
  if (typeof input === 'bigint') return input;
  if (input === '') return 0n;
  if (input.startsWith('0x') || input.startsWith('0X')) {
    return BigInt(input);
  }
  return BigInt(input);
}

// ---- Set operations --------------------------------------------------------

export function hasFlag(perms: bigint, flag: bigint): boolean {
  return (perms & flag) === flag;
}

export function addFlag(perms: bigint, flag: bigint): bigint {
  return perms | flag;
}

export function removeFlag(perms: bigint, flag: bigint): bigint {
  return perms & ~flag;
}

export function combine(...sets: bigint[]): bigint {
  return sets.reduce((acc, p) => acc | p, 0n);
}

// ---- Resolution ------------------------------------------------------------

/** In-memory representation of a permission overwrite (BigInt allow/deny). */
export interface ResolvedOverwrite {
  allow: bigint;
  deny: bigint;
}

export interface ResolveContext {
  /** Whether the user is the server owner. */
  isOwner: boolean;
  /** @everyone role permissions for this server. */
  everyoneRolePermissions: bigint;
  /** Other role permissions the user has on this server. */
  rolePermissions: bigint[];
  /** Channel-level overwrite for @everyone, if any. */
  everyoneChannelOverwrite?: ResolvedOverwrite;
  /** Channel-level overwrites tied to the user's roles. */
  roleChannelOverwrites?: ResolvedOverwrite[];
  /** Channel-level overwrite tied directly to the user, if any. */
  userChannelOverwrite?: ResolvedOverwrite;
}

/** Compute base server-level permissions for a member (no channel overwrites). */
export function computeBasePermissions(ctx: {
  isOwner: boolean;
  everyoneRolePermissions: bigint;
  rolePermissions: bigint[];
}): bigint {
  if (ctx.isOwner) return PERMISSION_ALL;
  let perms = ctx.everyoneRolePermissions;
  for (const rp of ctx.rolePermissions) {
    perms |= rp;
  }
  if (hasFlag(perms, Permission.ADMINISTRATOR)) return PERMISSION_ALL;
  return perms;
}

/** Compute final, channel-aware permissions for a member in a channel. */
export function computeChannelPermissions(ctx: ResolveContext): bigint {
  if (ctx.isOwner) return PERMISSION_ALL;

  let perms = computeBasePermissions({
    isOwner: false,
    everyoneRolePermissions: ctx.everyoneRolePermissions,
    rolePermissions: ctx.rolePermissions,
  });

  if (hasFlag(perms, Permission.ADMINISTRATOR)) return PERMISSION_ALL;

  // 1. @everyone channel overwrite
  if (ctx.everyoneChannelOverwrite) {
    perms &= ~ctx.everyoneChannelOverwrite.deny;
    perms |= ctx.everyoneChannelOverwrite.allow;
  }

  // 2. Role overwrites — combine all denies, then all allows.
  if (ctx.roleChannelOverwrites && ctx.roleChannelOverwrites.length > 0) {
    let combinedDeny = 0n;
    let combinedAllow = 0n;
    for (const o of ctx.roleChannelOverwrites) {
      combinedDeny |= o.deny;
      combinedAllow |= o.allow;
    }
    perms &= ~combinedDeny;
    perms |= combinedAllow;
  }

  // 3. User overwrite — most specific, applied last.
  if (ctx.userChannelOverwrite) {
    perms &= ~ctx.userChannelOverwrite.deny;
    perms |= ctx.userChannelOverwrite.allow;
  }

  return perms;
}

export function can(perms: bigint, flag: bigint): boolean {
  if (hasFlag(perms, Permission.ADMINISTRATOR)) return true;
  return hasFlag(perms, flag);
}

/** Convert a permission bitset to an array of flag names (debugging/UI). */
export function describePermissions(perms: bigint): PermissionFlag[] {
  return PermissionFlags.filter((flag) => hasFlag(perms, Permission[flag]));
}
