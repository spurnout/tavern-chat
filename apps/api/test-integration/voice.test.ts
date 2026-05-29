/**
 * Integration coverage for voice routes in `apps/api/src/routes/voice.ts`.
 *
 * Two test-app variants:
 *  - `buildTestApp()`:        no LiveKit env vars — voice endpoints that reach
 *    the LiveKit check return 503. Guards that fire BEFORE the LiveKit check
 *    (401, 400, 403, 404, 409) are still exercised because they come first in
 *    every handler.
 *  - `buildLiveKitApp()`:     dummy LiveKit vars set — `signLiveKitToken` signs
 *    a real HS256 JWT locally with `jose`, no live LiveKit server is contacted.
 *    Exercises the happy paths that return 200 with a token payload.
 *
 * Handler check order (relevant for which status codes are reachable per build):
 *
 * POST /api/voice/join
 *   requireUser → 401
 *   voiceJoinRequestSchema.parse(body) → 400
 *   channel lookup → 404
 *   channel type check → 400
 *   requireChannelPermission(CONNECT_VOICE) → 403
 *   LiveKit availability → 503 / continue
 *   signLiveKitToken + upsert VoiceState → 200
 *
 * POST /api/voice/refresh-token
 *   requireUser → 401
 *   parse body → 400
 *   channel lookup → 404
 *   channel type check → 400
 *   voiceState existence (must already be in channel) → 409
 *   requireChannelPermission(CONNECT_VOICE) → 403
 *   LiveKit availability → 503 / continue
 *   signLiveKitToken → 200
 *
 * POST /api/voice/leave
 *   requireUser → 401
 *   voiceState lookup (idempotent, 200 even if empty)
 *   updateMany + publish → 200
 *
 * POST /api/voice/state
 *   requireUser → 401
 *   voiceStateUpdateRequestSchema.parse(body) → 400
 *   channel lookup → 404
 *   channel type check → 400
 *   voiceState existence (must be in channel) → 409
 *   permission re-checks (screenSharing/cameraOn) → 403
 *   update + publish → 200
 *
 * POST /api/voice/:channelId/raise-hand
 *   requireUser → 401
 *   loadStageChannel (404 unknown, 400 non-stage) → 400/404
 *   voiceState audience check → 400
 *   update + publish → 200
 *
 * POST /api/voice/:channelId/lower-hand
 *   requireUser → 401
 *   loadStageChannel → 400/404
 *   voiceState not-in-channel → 200 (idempotent)
 *   update + publish → 200
 *
 * POST /api/voice/:channelId/promote/:userId
 *   requireUser → 401
 *   loadStageChannel → 400/404
 *   requireChannelPermission(MANAGE_CHANNELS) → 403
 *   target voiceState → 404
 *   update + publish → 200
 *
 * POST /api/voice/:channelId/demote/:userId
 *   requireUser → 401
 *   loadStageChannel → 400/404
 *   if not self-demote: requireChannelPermission(MANAGE_CHANNELS) → 403
 *   target voiceState → 404
 *   update + publish → 200
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  Permission,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  resetDb,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeUser(slug: string): Promise<string> {
  const id = ulid();
  const uname = `${slug}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: uname,
      usernameLower: uname,
      displayName: uname,
      email: `${uname}@example.test`,
      emailLower: `${uname}@example.test`,
      passwordHash: 'x',
    },
  });
  return id;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
}

interface ServerFixture {
  serverId: string;
  everyoneId: string;
}

/**
 * Create a server owned by `ownerId` with an @everyone role.
 * `extraEveryonePerms` is OR-ed on top of `PERMISSION_DEFAULT_EVERYONE`.
 */
async function makeServer(
  ownerId: string,
  extraEveryonePerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Voice Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE | extraEveryonePerms),
      ),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

/**
 * Create a server whose @everyone has NO voice permissions at all.
 * Used to produce 403 responses on voice routes.
 */
async function makeServerNoVoicePerms(ownerId: string): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  // Strip all voice bits from the default set.
  const noVoice =
    PERMISSION_DEFAULT_EVERYONE &
    ~(
      Permission.CONNECT_VOICE |
      Permission.SPEAK_VOICE |
      Permission.ENABLE_CAMERA |
      Permission.STREAM_SCREEN
    );
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Silent Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(noVoice)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId };
}

async function makeVoiceChannel(
  serverId: string,
  type: 'voice' | 'stage' | 'session' | 'campaign' = 'voice',
): Promise<string> {
  const id = ulid();
  await prisma.channel.create({
    data: { id, serverId, type, name: 'general-voice', videoEnabled: true },
  });
  return id;
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/**
 * Seed a VoiceState row so a user is "currently in" a channel.
 * Used to set up preconditions for /refresh-token, /state, /raise-hand, etc.
 */
async function joinVoiceState(
  serverId: string,
  userId: string,
  channelId: string,
  opts?: { stagePosition?: 'audience' | 'speaker' | null },
): Promise<void> {
  await prisma.voiceState.upsert({
    where: { serverId_userId: { serverId, userId } },
    create: {
      serverId,
      userId,
      channelId,
      joinedAt: new Date(),
      selfMute: false,
      selfDeaf: false,
      cameraOn: false,
      screenSharing: false,
      stagePosition: opts?.stagePosition ?? null,
      handRaisedAt: null,
    },
    update: {
      channelId,
      joinedAt: new Date(),
      selfMute: false,
      selfDeaf: false,
      cameraOn: false,
      screenSharing: false,
      stagePosition: opts?.stagePosition ?? null,
      handRaisedAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// App factories
// ---------------------------------------------------------------------------

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'false',
    PUBLIC_BASE_URL: 'http://localhost:3001',
  } as NodeJS.ProcessEnv;
}

/**
 * Env with dummy LiveKit credentials. signLiveKitToken uses `jose` to sign a
 * HS256 JWT locally — no live LiveKit server is required. The secret must be
 * at least 1 byte (there is no minimum-length constraint in the code); 32+
 * chars is safe for HS256.
 */
function envWithLiveKit(dbUrl: string): NodeJS.ProcessEnv {
  return {
    ...envFor(dbUrl),
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecretsuperlong12345678901234',
  } as NodeJS.ProcessEnv;
}

async function buildTestApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envFor(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

async function buildLiveKitApp() {
  const { buildApp } = await import('../src/app.js');
  const { loadConfig } = await import('../src/config.js');
  return buildApp({
    config: loadConfig(envWithLiveKit(ctx!.databaseUrl)),
    queuesOverride: {
      enqueueScan: vi.fn(async () => undefined),
      enqueueFederationOutbox: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  });
}

type OkBody<T> = { ok: true; data: T };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('voice routes (apps/api/src/routes/voice.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // =========================================================================
  // POST /api/voice/join — auth / validation / not-found guards
  // =========================================================================

  describe('POST /api/voice/join — guards (LiveKit disabled)', () => {
    it('returns 401 when no auth token is provided', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          payload: { channelId: ulid() },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the body is missing channelId', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when the channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: ulid() },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the channel is a text channel (wrong type)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const textChannelId = ulid();
      await prisma.channel.create({
        data: { id: textChannelId, serverId, type: 'text', name: 'general' },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: textChannelId },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when the caller lacks CONNECT_VOICE permission', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      // makeServerNoVoicePerms: everyone lacks CONNECT_VOICE
      const { serverId } = await makeServerNoVoicePerms(ownerId);
      await addMember(serverId, memberId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns 503 when the caller has permission but LiveKit is not configured', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/join — happy path (LiveKit enabled)
  // =========================================================================

  describe('POST /api/voice/join — happy path (LiveKit enabled)', () => {
    it('owner joining a voice channel gets a token and the voice state is upserted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          liveKitUrl: string;
          token: string;
          roomName: string;
          identity: string;
          allowedFeatures: {
            canPublishAudio: boolean;
            canPublishVideo: boolean;
            canPublishScreenShare: boolean;
            canSubscribe: boolean;
          };
          expiresAt: string;
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.token).toBeTruthy();
        expect(typeof body.data.token).toBe('string');
        expect(body.data.liveKitUrl).toBe('ws://localhost:7880');
        expect(body.data.roomName).toContain(serverId);
        expect(body.data.roomName).toContain(voiceChannelId);
        expect(body.data.identity).toBe(ownerId);
        expect(body.data.allowedFeatures.canSubscribe).toBe(true);
        expect(body.data.expiresAt).toBeTruthy();

        // VoiceState row was created
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(state).not.toBeNull();
        expect(state?.channelId).toBe(voiceChannelId);
        expect(state?.joinedAt).not.toBeNull();
        expect(state?.selfMute).toBe(false);
        expect(state?.screenSharing).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('member with full voice perms gets canPublishAudio and canPublishScreenShare true', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          allowedFeatures: { canPublishAudio: boolean; canPublishScreenShare: boolean };
        }>;
        // PERMISSION_DEFAULT_EVERYONE includes SPEAK_VOICE and STREAM_SCREEN
        expect(body.data.allowedFeatures.canPublishAudio).toBe(true);
        expect(body.data.allowedFeatures.canPublishScreenShare).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('joining a session channel (type=session) works the same as voice', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const sessionChannelId = await makeVoiceChannel(serverId, 'session');
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: sessionChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ token: string }>;
        expect(body.data.token).toBeTruthy();
      } finally {
        await app.close();
      }
    });

    it('joining a stage channel as a non-admin lands as audience (canPublishAudio=false)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: stageChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          allowedFeatures: { canPublishAudio: boolean };
        }>;
        // Audience members cannot publish audio on stage channels
        expect(body.data.allowedFeatures.canPublishAudio).toBe(false);

        // stagePosition is 'audience' in the DB
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.stagePosition).toBe('audience');
      } finally {
        await app.close();
      }
    });

    it('joining a stage channel as server owner lands as speaker (canPublishAudio=true)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: stageChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          allowedFeatures: { canPublishAudio: boolean };
        }>;
        expect(body.data.allowedFeatures.canPublishAudio).toBe(true);

        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(state?.stagePosition).toBe('speaker');
      } finally {
        await app.close();
      }
    });

    it('re-joining the same voice channel updates joinedAt and resets transient flags', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      // Seed a stale state with screenSharing=true
      await prisma.voiceState.upsert({
        where: { serverId_userId: { serverId, userId: ownerId } },
        create: {
          serverId,
          userId: ownerId,
          channelId: voiceChannelId,
          joinedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 minutes ago (stale)
          selfMute: true,
          selfDeaf: true,
          cameraOn: true,
          screenSharing: true,
        },
        update: {
          channelId: voiceChannelId,
          joinedAt: new Date(Date.now() - 20 * 60 * 1000),
          selfMute: true,
          selfDeaf: true,
          cameraOn: true,
          screenSharing: true,
        },
      });
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/join',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        // Fresh join resets all transient flags
        expect(state?.selfMute).toBe(false);
        expect(state?.selfDeaf).toBe(false);
        expect(state?.cameraOn).toBe(false);
        expect(state?.screenSharing).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/refresh-token
  // =========================================================================

  describe('POST /api/voice/refresh-token — guards (LiveKit disabled)', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          payload: { channelId: ulid() },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body is missing channelId', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: ulid() },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when channel is a text channel (wrong type)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const textChannelId = ulid();
      await prisma.channel.create({
        data: { id: textChannelId, serverId, type: 'text', name: 'general' },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: textChannelId },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 409 when the caller is not currently in the channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      // No VoiceState seeded — user is not in the channel
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it('returns 409 when voice state exists but points to a different channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const channelA = await makeVoiceChannel(serverId);
      const channelB = await makeVoiceChannel(serverId);
      // User is in channelA, not channelB
      await joinVoiceState(serverId, ownerId, channelA);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: channelB },
        });
        expect(res.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it('returns 503 when caller is in the channel but LiveKit is not configured', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(503);
      } finally {
        await app.close();
      }
    });
  });

  describe('POST /api/voice/refresh-token — happy path (LiveKit enabled)', () => {
    it('caller in the channel gets a refreshed token (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          token: string;
          expiresAt: string;
          allowedFeatures: {
            canPublishAudio: boolean;
            canPublishVideo: boolean;
            canPublishScreenShare: boolean;
            canSubscribe: boolean;
          };
        }>;
        expect(body.ok).toBe(true);
        expect(body.data.token).toBeTruthy();
        expect(typeof body.data.token).toBe('string');
        expect(body.data.expiresAt).toBeTruthy();
        expect(body.data.allowedFeatures.canSubscribe).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('audience member in a stage channel gets canPublishAudio=false on refresh', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // Seed audience state
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'audience' });
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: stageChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          allowedFeatures: { canPublishAudio: boolean };
        }>;
        expect(body.data.allowedFeatures.canPublishAudio).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('speaker in a stage channel gets canPublishAudio=true on refresh', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // Seed speaker state
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'speaker' });
      const app = await buildLiveKitApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/refresh-token',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: stageChannelId },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{
          allowedFeatures: { canPublishAudio: boolean };
        }>;
        expect(body.data.allowedFeatures.canPublishAudio).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/leave
  // =========================================================================

  describe('POST /api/voice/leave', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({ method: 'POST', url: '/api/voice/leave' });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 200 when the caller is not in any voice channel (idempotent)', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/leave',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('clears the voice state and returns 200 after leaving', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/leave',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        // Row stays but channelId is cleared (not deleted)
        expect(state?.channelId).toBeNull();
        expect(state?.joinedAt).toBeNull();
        expect(state?.selfMute).toBe(false);
        expect(state?.screenSharing).toBe(false);
      } finally {
        await app.close();
      }
    });

    it('leave is idempotent — second call also returns 200', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        await app.inject({
          method: 'POST',
          url: '/api/voice/leave',
          headers: { authorization: `Bearer ${token}` },
        });
        // Second leave — already cleared
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/leave',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/state
  // =========================================================================

  describe('POST /api/voice/state', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          payload: { channelId: ulid(), selfMute: true },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when body is missing channelId', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { selfMute: true }, // no channelId
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: ulid(), selfMute: true },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when channel is a text channel (wrong type)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const textChannelId = ulid();
      await prisma.channel.create({
        data: { id: textChannelId, serverId, type: 'text', name: 'chat' },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: textChannelId, selfMute: true },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 409 when caller is not currently in the voice channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      // No VoiceState row — user never joined
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId, selfMute: true },
        });
        expect(res.statusCode).toBe(409);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when caller tries to enable screen sharing without STREAM_SCREEN', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      // Strip STREAM_SCREEN from everyone
      const permsNoScreen =
        PERMISSION_DEFAULT_EVERYONE & ~Permission.STREAM_SCREEN;
      const serverId = ulid();
      const everyoneId = ulid();
      await prisma.server.create({
        data: { id: serverId, ownerUserId: ownerId, name: 'NoScreen Tavern' },
      });
      await prisma.role.create({
        data: {
          id: everyoneId,
          serverId,
          name: '@everyone',
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(permsNoScreen)),
        },
      });
      await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
      await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
      await addMember(serverId, memberId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, memberId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId, screenSharing: true },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when caller tries to enable camera on a channel where video is disabled', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      // Create voice channel with videoEnabled=false
      const noVideoChannelId = ulid();
      await prisma.channel.create({
        data: {
          id: noVideoChannelId,
          serverId,
          type: 'voice',
          name: 'no-video',
          videoEnabled: false,
        },
      });
      await joinVoiceState(serverId, ownerId, noVideoChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: noVideoChannelId, cameraOn: true },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('updates selfMute=true for a caller in the channel (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId, selfMute: true },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(state?.selfMute).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('updates selfDeaf=true for a caller in the channel (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId, selfDeaf: true },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(state?.selfDeaf).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('owner can enable camera and screenSharing simultaneously (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId);
      await joinVoiceState(serverId, ownerId, voiceChannelId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: '/api/voice/state',
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: voiceChannelId, cameraOn: true, screenSharing: true },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: ownerId } },
        });
        expect(state?.cameraOn).toBe(true);
        expect(state?.screenSharing).toBe(true);
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/raise-hand
  // =========================================================================

  describe('POST /api/voice/:channelId/raise-hand', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/raise-hand`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/raise-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the channel is not a stage channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId, 'voice');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${voiceChannelId}/raise-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the caller is not in the stage channel as audience', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // No VoiceState — not in the channel
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/raise-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when the caller is already a speaker (not audience)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, ownerId, stageChannelId, { stagePosition: 'speaker' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/raise-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('audience member raises hand successfully (200) and handRaisedAt is set', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'audience' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/raise-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.handRaisedAt).not.toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/lower-hand
  // =========================================================================

  describe('POST /api/voice/:channelId/lower-hand', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/lower-hand`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/lower-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when channel is not a stage channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId, 'voice');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${voiceChannelId}/lower-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 200 when caller is not in the channel (idempotent)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // No VoiceState for owner
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/lower-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it('clears handRaisedAt and returns 200 when caller had their hand raised', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'audience' });
      // Raise hand first
      await prisma.voiceState.update({
        where: { serverId_userId: { serverId, userId: memberId } },
        data: { handRaisedAt: new Date() },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/lower-hand`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.handRaisedAt).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/promote/:userId
  // =========================================================================

  describe('POST /api/voice/:channelId/promote/:userId', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/promote/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/promote/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when channel is not a stage channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId, 'voice');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${voiceChannelId}/promote/${ownerId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when caller lacks MANAGE_CHANNELS', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const targetId = await makeUser('target');
      // Strip MANAGE_CHANNELS from everyone — owner never goes through perm check
      const permsNoManage =
        PERMISSION_DEFAULT_EVERYONE & ~Permission.MANAGE_CHANNELS;
      const serverId = ulid();
      const everyoneId = ulid();
      await prisma.server.create({
        data: { id: serverId, ownerUserId: ownerId, name: 'NoManage Tavern' },
      });
      await prisma.role.create({
        data: {
          id: everyoneId,
          serverId,
          name: '@everyone',
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(permsNoManage)),
        },
      });
      await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
      await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
      await addMember(serverId, memberId);
      await addMember(serverId, targetId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, targetId, stageChannelId, { stagePosition: 'audience' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/promote/${targetId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when target user is not in the stage', async () => {
      const ownerId = await makeUser('owner');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, targetId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // targetId never joined the stage
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/promote/${targetId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('owner promotes an audience member to speaker (200) and stagePosition is updated', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'audience' });
      // Raise hand first
      await prisma.voiceState.update({
        where: { serverId_userId: { serverId, userId: memberId } },
        data: { handRaisedAt: new Date() },
      });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/promote/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ ok: boolean }>;
        expect(body.ok).toBe(true);

        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.stagePosition).toBe('speaker');
        // Promotion clears the raised-hand flag
        expect(state?.handRaisedAt).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  // =========================================================================
  // POST /api/voice/:channelId/demote/:userId
  // =========================================================================

  describe('POST /api/voice/:channelId/demote/:userId', () => {
    it('returns 401 without a token', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/demote/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for an unknown channel', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${ulid()}/demote/${ownerId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns 400 when channel is not a stage channel', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const voiceChannelId = await makeVoiceChannel(serverId, 'voice');
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${voiceChannelId}/demote/${ownerId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('returns 403 when a non-owner tries to demote someone else without MANAGE_CHANNELS', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const targetId = await makeUser('target');
      const permsNoManage =
        PERMISSION_DEFAULT_EVERYONE & ~Permission.MANAGE_CHANNELS;
      const serverId = ulid();
      const everyoneId = ulid();
      await prisma.server.create({
        data: { id: serverId, ownerUserId: ownerId, name: 'Demote Tavern' },
      });
      await prisma.role.create({
        data: {
          id: everyoneId,
          serverId,
          name: '@everyone',
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(permsNoManage)),
        },
      });
      await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
      await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
      await addMember(serverId, memberId);
      await addMember(serverId, targetId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, targetId, stageChannelId, { stagePosition: 'speaker' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/demote/${targetId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when target user is not in the stage', async () => {
      const ownerId = await makeUser('owner');
      const targetId = await makeUser('target');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, targetId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      // targetId never joined
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/demote/${targetId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('owner demotes a speaker to audience (200) and stagePosition is updated', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'speaker' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/demote/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.stagePosition).toBe('audience');
        expect(state?.handRaisedAt).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a speaker can self-demote without MANAGE_CHANNELS (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const permsNoManage =
        PERMISSION_DEFAULT_EVERYONE & ~Permission.MANAGE_CHANNELS;
      const serverId = ulid();
      const everyoneId = ulid();
      await prisma.server.create({
        data: { id: serverId, ownerUserId: ownerId, name: 'Self-demote Tavern' },
      });
      await prisma.role.create({
        data: {
          id: everyoneId,
          serverId,
          name: '@everyone',
          isEveryone: true,
          permissions: new Prisma.Decimal(serializePermissions(permsNoManage)),
        },
      });
      await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
      await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
      await addMember(serverId, memberId);
      const stageChannelId = await makeVoiceChannel(serverId, 'stage');
      await joinVoiceState(serverId, memberId, stageChannelId, { stagePosition: 'speaker' });
      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        // Self-demote: userId in URL == caller's userId
        const res = await app.inject({
          method: 'POST',
          url: `/api/voice/${stageChannelId}/demote/${memberId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const state = await prisma.voiceState.findUnique({
          where: { serverId_userId: { serverId, userId: memberId } },
        });
        expect(state?.stagePosition).toBe('audience');
      } finally {
        await app.close();
      }
    });
  });
});
