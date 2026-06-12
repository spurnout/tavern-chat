import { describe, expect, it } from 'vitest';
import {
  channelSchema,
  channelTypeSchema,
  createChannelRequestSchema,
  federationModeSchema,
  permissionOverwriteSchema,
  permissionOverwriteTargetTypeSchema,
  updateChannelRequestSchema,
  upsertPermissionOverwriteRequestSchema,
} from '../src/schemas/channels.js';
import { NAME_LIMITS } from '../src/constants.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const ULID3 = '01HZX7Q4Y3K9V0G8WMC2P5N6BT';

describe('channelTypeSchema', () => {
  it.each([
    'category',
    'text',
    'voice',
    'campaign',
    'session',
    'board_game',
    'stage',
    'forum',
  ])('accepts channel type %s', (type) => {
    expect(channelTypeSchema.safeParse(type).success).toBe(true);
  });

  it('rejects an unknown channel type', () => {
    expect(channelTypeSchema.safeParse('dm').success).toBe(false);
  });
});

describe('federationModeSchema', () => {
  it.each(['inherit', 'force_on', 'force_off'])('accepts mode %s', (mode) => {
    expect(federationModeSchema.safeParse(mode).success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(federationModeSchema.safeParse('on').success).toBe(false);
  });
});

const baseChannel = {
  id: ULID,
  serverId: ULID,
  parentId: null,
  campaignId: null,
  gameNightId: null,
  type: 'text',
  name: 'general',
  topic: null,
  position: 0,
  nsfw: false,
  videoEnabled: false,
  createdAt: new Date().toISOString(),
};

describe('channelSchema', () => {
  it('accepts a minimal channel and defaults federationMode to inherit', () => {
    const parsed = channelSchema.parse(baseChannel);
    expect(parsed.federationMode).toBe('inherit');
  });

  it('accepts an explicit federationMode override', () => {
    const parsed = channelSchema.parse({ ...baseChannel, federationMode: 'force_off' });
    expect(parsed.federationMode).toBe('force_off');
  });

  it('accepts a channel with parent / campaign / gameNight ids set', () => {
    const result = channelSchema.safeParse({
      ...baseChannel,
      parentId: ULID2,
      campaignId: ULID2,
      gameNightId: ULID2,
      topic: 'a topic',
    });
    expect(result.success).toBe(true);
  });

  it('accepts active voice states on room-list payloads', () => {
    const result = channelSchema.safeParse({
      ...baseChannel,
      type: 'voice',
      videoEnabled: true,
      voiceStates: [
        {
          serverId: ULID,
          userId: ULID3,
          channelId: ULID,
          selfMute: false,
          selfDeaf: false,
          cameraOn: false,
          screenSharing: true,
          joinedAt: '2026-06-11T12:00:00.000Z',
          stagePosition: null,
          handRaisedAt: null,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a name that is too long', () => {
    expect(
      channelSchema.safeParse({
        ...baseChannel,
        name: 'n'.repeat(NAME_LIMITS.MAX_CHANNEL_NAME + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an empty name (below the min)', () => {
    expect(channelSchema.safeParse({ ...baseChannel, name: '' }).success).toBe(false);
  });

  it('rejects a topic that exceeds MAX_TOPIC', () => {
    expect(
      channelSchema.safeParse({ ...baseChannel, topic: 't'.repeat(NAME_LIMITS.MAX_TOPIC + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects a negative position', () => {
    expect(channelSchema.safeParse({ ...baseChannel, position: -1 }).success).toBe(false);
  });

  it('rejects a non-integer position', () => {
    expect(channelSchema.safeParse({ ...baseChannel, position: 1.5 }).success).toBe(false);
  });

  it('rejects an invalid federationMode', () => {
    expect(channelSchema.safeParse({ ...baseChannel, federationMode: 'maybe' }).success).toBe(
      false,
    );
  });

  it('rejects a non-ULID serverId', () => {
    expect(channelSchema.safeParse({ ...baseChannel, serverId: 'bad' }).success).toBe(false);
  });
});

describe('createChannelRequestSchema', () => {
  it('accepts a minimal create request', () => {
    expect(createChannelRequestSchema.safeParse({ type: 'text', name: 'general' }).success).toBe(
      true,
    );
  });

  it('accepts optional parentId / topic / nsfw / videoEnabled', () => {
    const result = createChannelRequestSchema.safeParse({
      type: 'voice',
      name: 'lounge',
      parentId: ULID,
      topic: 'chill',
      nsfw: false,
      videoEnabled: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a null parentId', () => {
    expect(
      createChannelRequestSchema.safeParse({ type: 'text', name: 'x', parentId: null }).success,
    ).toBe(true);
  });

  it('rejects a missing type', () => {
    expect(createChannelRequestSchema.safeParse({ name: 'general' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createChannelRequestSchema.safeParse({ type: 'text', name: '' }).success).toBe(false);
  });

  it('rejects an over-long topic', () => {
    expect(
      createChannelRequestSchema.safeParse({
        type: 'text',
        name: 'x',
        topic: 't'.repeat(NAME_LIMITS.MAX_TOPIC + 1),
      }).success,
    ).toBe(false);
  });
});

describe('updateChannelRequestSchema', () => {
  it('accepts an empty partial update', () => {
    expect(updateChannelRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a name-only update', () => {
    expect(updateChannelRequestSchema.safeParse({ name: 'renamed' }).success).toBe(true);
  });

  it('accepts position, slowmodeSeconds, postingScope and federationMode', () => {
    const result = updateChannelRequestSchema.safeParse({
      name: 'renamed',
      position: 3,
      slowmodeSeconds: 120,
      postingScope: 'mods_only',
      federationMode: 'force_on',
    });
    expect(result.success).toBe(true);
  });

  it('accepts the slowmode upper bound (6h)', () => {
    expect(updateChannelRequestSchema.safeParse({ slowmodeSeconds: 6 * 60 * 60 }).success).toBe(
      true,
    );
  });

  it('does not allow the omitted `type` field to be set', () => {
    const parsed = updateChannelRequestSchema.parse({ type: 'voice', name: 'x' });
    expect('type' in parsed).toBe(false);
  });

  it('rejects a slowmodeSeconds above the 6h cap', () => {
    expect(
      updateChannelRequestSchema.safeParse({ slowmodeSeconds: 6 * 60 * 60 + 1 }).success,
    ).toBe(false);
  });

  it('rejects a negative slowmodeSeconds', () => {
    expect(updateChannelRequestSchema.safeParse({ slowmodeSeconds: -1 }).success).toBe(false);
  });

  it('rejects an unknown postingScope', () => {
    expect(updateChannelRequestSchema.safeParse({ postingScope: 'everyone' }).success).toBe(false);
  });

  it('rejects a negative position', () => {
    expect(updateChannelRequestSchema.safeParse({ position: -1 }).success).toBe(false);
  });
});

describe('permissionOverwriteTargetTypeSchema', () => {
  it.each(['role', 'user'])('accepts target type %s', (t) => {
    expect(permissionOverwriteTargetTypeSchema.safeParse(t).success).toBe(true);
  });

  it('rejects an unknown target type', () => {
    expect(permissionOverwriteTargetTypeSchema.safeParse('group').success).toBe(false);
  });
});

describe('permissionOverwriteSchema', () => {
  it('accepts a well-formed overwrite', () => {
    const result = permissionOverwriteSchema.safeParse({
      id: ULID,
      channelId: ULID2,
      targetType: 'role',
      targetId: ULID,
      allow: '1024',
      deny: '0',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid targetType', () => {
    expect(
      permissionOverwriteSchema.safeParse({
        id: ULID,
        channelId: ULID2,
        targetType: 'channel',
        targetId: ULID,
        allow: '0',
        deny: '0',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ULID targetId', () => {
    expect(
      permissionOverwriteSchema.safeParse({
        id: ULID,
        channelId: ULID2,
        targetType: 'user',
        targetId: 'bad',
        allow: '0',
        deny: '0',
      }).success,
    ).toBe(false);
  });
});

describe('upsertPermissionOverwriteRequestSchema', () => {
  it('accepts a valid upsert request', () => {
    const result = upsertPermissionOverwriteRequestSchema.safeParse({
      targetType: 'user',
      targetId: ULID,
      allow: '2048',
      deny: '4',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing allow field', () => {
    expect(
      upsertPermissionOverwriteRequestSchema.safeParse({
        targetType: 'user',
        targetId: ULID,
        deny: '0',
      }).success,
    ).toBe(false);
  });
});
