import { describe, expect, it } from 'vitest';
import {
  createInviteRequestSchema,
  inviteScopeSchema,
  inviteSchema,
  remoteInviteScopeSchema,
} from '../src/schemas/invites.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';

describe('inviteScopeSchema', () => {
  it.each(['instance', 'server'])('accepts scope %s', (scope) => {
    expect(inviteScopeSchema.safeParse(scope).success).toBe(true);
  });

  it('rejects an unknown scope', () => {
    expect(inviteScopeSchema.safeParse('channel').success).toBe(false);
  });
});

describe('remoteInviteScopeSchema', () => {
  it.each(['any_peer', 'specific_instance', 'specific_user'])('accepts remote scope %s', (s) => {
    expect(remoteInviteScopeSchema.safeParse(s).success).toBe(true);
  });

  it('rejects an unknown remote scope', () => {
    expect(remoteInviteScopeSchema.safeParse('global').success).toBe(false);
  });
});

const baseInvite = {
  id: ULID,
  code: 'JOIN-ME',
  scope: 'server',
  serverId: ULID,
  channelId: null,
  createdById: ULID,
  maxUses: 10,
  uses: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date().toISOString(),
  remoteScope: null,
  remoteInstanceHost: null,
  remoteUserId: null,
};

describe('inviteSchema', () => {
  it('accepts a local server invite', () => {
    expect(inviteSchema.safeParse(baseInvite).success).toBe(true);
  });

  it('accepts an instance invite with nulled server/channel ids and unlimited uses', () => {
    const result = inviteSchema.safeParse({
      ...baseInvite,
      scope: 'instance',
      serverId: null,
      createdById: null,
      maxUses: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a federated invite with remote targeting fields', () => {
    const result = inviteSchema.safeParse({
      ...baseInvite,
      remoteScope: 'specific_user',
      remoteInstanceHost: 'b.example',
      remoteUserId: 'alice@b.example',
      expiresAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive maxUses', () => {
    expect(inviteSchema.safeParse({ ...baseInvite, maxUses: 0 }).success).toBe(false);
  });

  it('rejects a negative uses count', () => {
    expect(inviteSchema.safeParse({ ...baseInvite, uses: -1 }).success).toBe(false);
  });

  it('rejects a non-datetime createdAt', () => {
    expect(inviteSchema.safeParse({ ...baseInvite, createdAt: 'now' }).success).toBe(false);
  });

  it('rejects a non-datetime expiresAt when present', () => {
    expect(inviteSchema.safeParse({ ...baseInvite, expiresAt: 'soon' }).success).toBe(false);
  });

  it('rejects an invalid remoteScope', () => {
    expect(inviteSchema.safeParse({ ...baseInvite, remoteScope: 'anyone' }).success).toBe(false);
  });

  it('rejects an absent (undefined) remoteScope — it is required, only nullable', () => {
    const { remoteScope: _omit, ...withoutRemoteScope } = baseInvite;
    expect(inviteSchema.safeParse(withoutRemoteScope).success).toBe(false);
  });
});

describe('createInviteRequestSchema', () => {
  it('accepts a minimal request with only a scope', () => {
    expect(createInviteRequestSchema.safeParse({ scope: 'server' }).success).toBe(true);
  });

  it('accepts a fully-specified federated request', () => {
    const result = createInviteRequestSchema.safeParse({
      scope: 'server',
      serverId: ULID,
      channelId: ULID,
      maxUses: 100,
      expiresInSeconds: 3600,
      remoteScope: 'specific_instance',
      remoteInstanceHost: 'peer.example',
      remoteUserId: 'bob@peer.example',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the maxUses upper bound (10,000)', () => {
    expect(createInviteRequestSchema.safeParse({ scope: 'server', maxUses: 10_000 }).success).toBe(
      true,
    );
  });

  it('accepts the one-year expiresInSeconds upper bound', () => {
    expect(
      createInviteRequestSchema.safeParse({ scope: 'server', expiresInSeconds: 60 * 60 * 24 * 365 })
        .success,
    ).toBe(true);
  });

  it('rejects a missing scope', () => {
    expect(createInviteRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects maxUses above 10,000', () => {
    expect(createInviteRequestSchema.safeParse({ scope: 'server', maxUses: 10_001 }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive maxUses', () => {
    expect(createInviteRequestSchema.safeParse({ scope: 'server', maxUses: 0 }).success).toBe(
      false,
    );
  });

  it('rejects expiresInSeconds beyond one year', () => {
    expect(
      createInviteRequestSchema.safeParse({
        scope: 'server',
        expiresInSeconds: 60 * 60 * 24 * 365 + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty remoteInstanceHost', () => {
    expect(
      createInviteRequestSchema.safeParse({ scope: 'server', remoteInstanceHost: '' }).success,
    ).toBe(false);
  });

  it('rejects an over-long remoteInstanceHost (>253)', () => {
    expect(
      createInviteRequestSchema.safeParse({
        scope: 'server',
        remoteInstanceHost: 'h'.repeat(254),
      }).success,
    ).toBe(false);
  });

  it('rejects a too-short remoteUserId (<3)', () => {
    expect(
      createInviteRequestSchema.safeParse({ scope: 'server', remoteUserId: 'ab' }).success,
    ).toBe(false);
  });

  it('rejects an invalid remoteScope enum', () => {
    expect(
      createInviteRequestSchema.safeParse({ scope: 'server', remoteScope: 'everyone' }).success,
    ).toBe(false);
  });
});
