import { describe, expect, it } from 'vitest';
import {
  assignRolesRequestSchema,
  createRoleRequestSchema,
  roleSchema,
  updateRoleRequestSchema,
} from '../src/schemas/roles.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';

describe('roleSchema', () => {
  const valid = {
    id: ULID,
    serverId: ULID2,
    name: 'Moderator',
    color: 0x5865f2,
    position: 5,
    permissions: '255',
    mentionable: true,
    hoist: false,
    isEveryone: false,
  };

  it('accepts a well-formed role', () => {
    expect(roleSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts color at the lower bound (0)', () => {
    expect(roleSchema.safeParse({ ...valid, color: 0 }).success).toBe(true);
  });

  it('accepts color at the upper bound (0xffffff)', () => {
    expect(roleSchema.safeParse({ ...valid, color: 0xffffff }).success).toBe(true);
  });

  it('rejects a negative color', () => {
    expect(roleSchema.safeParse({ ...valid, color: -1 }).success).toBe(false);
  });

  it('rejects a color above 0xffffff', () => {
    expect(roleSchema.safeParse({ ...valid, color: 0x1000000 }).success).toBe(false);
  });

  it('rejects a non-integer color', () => {
    expect(roleSchema.safeParse({ ...valid, color: 1.5 }).success).toBe(false);
  });

  it('accepts position at the upper bound (65535)', () => {
    expect(roleSchema.safeParse({ ...valid, position: 65535 }).success).toBe(true);
  });

  it('rejects a position above the maximum', () => {
    expect(roleSchema.safeParse({ ...valid, position: 65536 }).success).toBe(false);
  });

  it('rejects a negative position', () => {
    expect(roleSchema.safeParse({ ...valid, position: -1 }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(roleSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
  });

  it('rejects a name longer than 64 chars', () => {
    expect(roleSchema.safeParse({ ...valid, name: 'a'.repeat(65) }).success).toBe(false);
  });

  it('rejects a non-boolean mentionable', () => {
    expect(roleSchema.safeParse({ ...valid, mentionable: 'yes' }).success).toBe(false);
  });

  it('rejects a missing isEveryone', () => {
    const { isEveryone: _omit, ...rest } = valid;
    expect(roleSchema.safeParse(rest).success).toBe(false);
  });
});

describe('createRoleRequestSchema', () => {
  it('accepts just a name (all else optional)', () => {
    expect(createRoleRequestSchema.safeParse({ name: 'New Role' }).success).toBe(true);
  });

  it('accepts a full request', () => {
    const result = createRoleRequestSchema.safeParse({
      name: 'Admin',
      color: 0xff0000,
      permissions: '1023',
      mentionable: false,
      hoist: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing name', () => {
    expect(createRoleRequestSchema.safeParse({ color: 0 }).success).toBe(false);
  });

  it('rejects an out-of-range color', () => {
    expect(createRoleRequestSchema.safeParse({ name: 'x', color: -5 }).success).toBe(false);
  });
});

describe('updateRoleRequestSchema', () => {
  it('accepts an empty object (all optional via partial)', () => {
    expect(updateRoleRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a position-only update', () => {
    expect(updateRoleRequestSchema.safeParse({ position: 12 }).success).toBe(true);
  });

  it('accepts a name + position update', () => {
    expect(updateRoleRequestSchema.safeParse({ name: 'Renamed', position: 0 }).success).toBe(
      true,
    );
  });

  it('rejects a position above the maximum', () => {
    expect(updateRoleRequestSchema.safeParse({ position: 70000 }).success).toBe(false);
  });
});

describe('assignRolesRequestSchema', () => {
  it('accepts an empty role list', () => {
    expect(assignRolesRequestSchema.safeParse({ roleIds: [] }).success).toBe(true);
  });

  it('accepts a list of valid ULIDs', () => {
    expect(assignRolesRequestSchema.safeParse({ roleIds: [ULID, ULID2] }).success).toBe(true);
  });

  it('rejects a list containing a non-ULID', () => {
    expect(assignRolesRequestSchema.safeParse({ roleIds: [ULID, 'bad'] }).success).toBe(false);
  });

  it('rejects a missing roleIds', () => {
    expect(assignRolesRequestSchema.safeParse({}).success).toBe(false);
  });
});
