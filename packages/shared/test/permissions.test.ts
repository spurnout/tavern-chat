import { describe, expect, it } from 'vitest';
import {
  Permission,
  PERMISSION_ALL,
  PERMISSION_DEFAULT_EVERYONE,
  addFlag,
  can,
  combine,
  computeBasePermissions,
  computeChannelPermissions,
  describePermissions,
  hasFlag,
  parsePermissions,
  removeFlag,
  serializePermissions,
} from '../src/permissions.js';

describe('permissions: bitset basics', () => {
  it('serialises and parses BigInt bitsets via decimal strings', () => {
    const perms = Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL;
    const serialised = serializePermissions(perms);
    expect(typeof serialised).toBe('string');
    expect(parsePermissions(serialised)).toBe(perms);
  });

  it('parses hex strings as well', () => {
    const hex = '0x' + (Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL).toString(16);
    expect(parsePermissions(hex)).toBe(Permission.SEND_MESSAGES | Permission.VIEW_CHANNEL);
  });

  it('addFlag/removeFlag/hasFlag are pure helpers', () => {
    let perms = 0n;
    perms = addFlag(perms, Permission.SEND_MESSAGES);
    expect(hasFlag(perms, Permission.SEND_MESSAGES)).toBe(true);
    perms = removeFlag(perms, Permission.SEND_MESSAGES);
    expect(hasFlag(perms, Permission.SEND_MESSAGES)).toBe(false);
  });

  it('combine OR-folds inputs', () => {
    const c = combine(Permission.SEND_MESSAGES, Permission.READ_MESSAGE_HISTORY);
    expect(hasFlag(c, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasFlag(c, Permission.READ_MESSAGE_HISTORY)).toBe(true);
    expect(hasFlag(c, Permission.MANAGE_SERVER)).toBe(false);
  });

  it('describePermissions lists set flags by name', () => {
    const perms = Permission.SEND_MESSAGES | Permission.MANAGE_SERVER;
    const names = describePermissions(perms);
    expect(names).toContain('SEND_MESSAGES');
    expect(names).toContain('MANAGE_SERVER');
    expect(names).not.toContain('ADMINISTRATOR');
  });
});

describe('permissions: server owner short-circuits to ALL', () => {
  it('owners get every permission regardless of role configuration', () => {
    const perms = computeBasePermissions({
      isOwner: true,
      everyoneRolePermissions: 0n,
      rolePermissions: [],
    });
    expect(perms).toBe(PERMISSION_ALL);
    expect(can(perms, Permission.MANAGE_INSTANCE_SAFETY_POLICY)).toBe(true);
  });
});

describe('permissions: ADMINISTRATOR short-circuits to ALL', () => {
  it('any role with ADMINISTRATOR yields all permissions', () => {
    const perms = computeBasePermissions({
      isOwner: false,
      everyoneRolePermissions: 0n,
      rolePermissions: [Permission.ADMINISTRATOR],
    });
    expect(perms).toBe(PERMISSION_ALL);
    expect(can(perms, Permission.BAN_MEMBERS)).toBe(true);
  });
});

describe('permissions: role union behaviour', () => {
  it('unions @everyone and additional roles', () => {
    const perms = computeBasePermissions({
      isOwner: false,
      everyoneRolePermissions: Permission.VIEW_CHANNEL,
      rolePermissions: [Permission.SEND_MESSAGES, Permission.ADD_REACTIONS],
    });
    expect(can(perms, Permission.VIEW_CHANNEL)).toBe(true);
    expect(can(perms, Permission.SEND_MESSAGES)).toBe(true);
    expect(can(perms, Permission.ADD_REACTIONS)).toBe(true);
    expect(can(perms, Permission.MANAGE_CHANNELS)).toBe(false);
  });
});

describe('permissions: channel overwrite resolution', () => {
  it('@everyone overwrite is applied first (deny then allow)', () => {
    const perms = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      everyoneChannelOverwrite: { allow: 0n, deny: Permission.SEND_MESSAGES },
    });
    expect(can(perms, Permission.SEND_MESSAGES)).toBe(false);
    expect(can(perms, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it('role overwrites combine deny/allow across all roles', () => {
    const perms = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      everyoneChannelOverwrite: { allow: 0n, deny: Permission.SEND_MESSAGES },
      roleChannelOverwrites: [
        { allow: Permission.SEND_MESSAGES, deny: 0n },
        { allow: 0n, deny: Permission.ADD_REACTIONS },
      ],
    });
    expect(can(perms, Permission.SEND_MESSAGES)).toBe(true);
    expect(can(perms, Permission.ADD_REACTIONS)).toBe(false);
  });

  it('user overwrite is the most specific and overrides role overwrites', () => {
    const perms = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      roleChannelOverwrites: [{ allow: Permission.SEND_MESSAGES, deny: 0n }],
      userChannelOverwrite: { allow: 0n, deny: Permission.SEND_MESSAGES },
    });
    expect(can(perms, Permission.SEND_MESSAGES)).toBe(false);
  });

  it('owner bypasses channel overwrites entirely', () => {
    const perms = computeChannelPermissions({
      isOwner: true,
      everyoneRolePermissions: 0n,
      rolePermissions: [],
      everyoneChannelOverwrite: { allow: 0n, deny: PERMISSION_ALL },
      userChannelOverwrite: { allow: 0n, deny: PERMISSION_ALL },
    });
    expect(perms).toBe(PERMISSION_ALL);
  });
});

describe('permissions: hidden channel reasoning', () => {
  it('VIEW_CHANNEL deny removes view but ADMINISTRATOR still sees', () => {
    const member = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [],
      everyoneChannelOverwrite: { allow: 0n, deny: Permission.VIEW_CHANNEL },
    });
    expect(can(member, Permission.VIEW_CHANNEL)).toBe(false);

    const admin = computeChannelPermissions({
      isOwner: false,
      everyoneRolePermissions: PERMISSION_DEFAULT_EVERYONE,
      rolePermissions: [Permission.ADMINISTRATOR],
      everyoneChannelOverwrite: { allow: 0n, deny: Permission.VIEW_CHANNEL },
    });
    expect(can(admin, Permission.VIEW_CHANNEL)).toBe(true);
  });
});
