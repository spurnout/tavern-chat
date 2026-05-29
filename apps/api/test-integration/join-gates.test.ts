/**
 * Integration coverage for the join-gate surface in
 * `apps/api/src/routes/join-gates.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET  /api/servers/:id/join-gate         → VIEW_CHANNEL (any member)
 *   - PUT  /api/servers/:id/join-gate         → MANAGE_SERVER_SAFETY_POLICY (mods/owner)
 *   - POST /api/servers/:id/join-gate/answers → must be a server member (no perm bit)
 *   - GET  /api/servers/:id/join-gate/pending → MANAGE_MESSAGES (mods/owner)
 *   - POST /api/servers/:id/join-gate/review/:userId → MANAGE_MESSAGES; also
 *       stamps gatePassedAt on ServerMember when approved=true.
 *
 * Fixtures: a server (owner) with an @everyone role + one text channel.
 * Federation is off so no route touches the outbound queue.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, Permission, serializePermissions, ulid } from '@tavern/shared';
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
// Helpers
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
  channelId: string;
}

/**
 * A server owned by `ownerId` with an @everyone role + one text channel.
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Gate Tavern' },
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'lobby' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Seed a JoinGate directly. */
async function makeJoinGate(
  serverId: string,
  opts: {
    rulesMd?: string;
    questionsJson?: object;
    enabled?: boolean;
  } = {},
): Promise<void> {
  await prisma.joinGate.create({
    data: {
      serverId,
      rulesMd: opts.rulesMd ?? 'Be kind.',
      questionsJson: (opts.questionsJson ?? []) as object,
      enabled: opts.enabled ?? false,
    },
  });
}

/** Seed a JoinGateAnswer for `userId` in `serverId`. */
async function makeJoinGateAnswer(
  serverId: string,
  userId: string,
  answersJson: Record<string, string> = {},
): Promise<void> {
  await prisma.joinGateAnswer.create({
    data: {
      serverId,
      userId,
      answersJson: answersJson as object,
    },
  });
}

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

type OkBody<T> = { ok: true; data: T };
type JoinGateDto = {
  serverId: string;
  rulesMd: string;
  questionsJson: unknown;
  enabled: boolean;
};
type JoinGateAnswerDto = {
  serverId: string;
  userId: string;
  answersJson: unknown;
  approved: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('join-gate routes (apps/api/src/routes/join-gates.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // ---- GET /api/servers/:id/join-gate ------------------------------------

  it('the server owner can GET the join gate (200) when it exists', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeJoinGate(serverId, {
      rulesMd: 'No trolling.',
      questionsJson: [{ id: 'q1', label: 'Why join?', required: true }],
      enabled: true,
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateDto>;
      expect(body.ok).toBe(true);
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.rulesMd).toBe('No trolling.');
      expect(body.data.enabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns ok(null) when no join gate exists for the server (200)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<null>;
      expect(body.data).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a regular member (VIEW_CHANNEL via @everyone) can GET the join gate (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: false });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateDto>;
      expect(body.data.serverId).toBe(serverId);
    } finally {
      await app.close();
    }
  });

  it('GET .../join-gate is 403 for a non-member (no VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    await makeJoinGate(serverId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET .../join-gate without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/join-gate`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- PUT /api/servers/:id/join-gate ------------------------------------

  it('the server owner can upsert (create) a join gate (200); DB row matches', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          rulesMd: '1. Be respectful.',
          questionsJson: [{ id: 'age', label: 'Are you 18+?', required: true }],
          enabled: true,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateDto>;
      expect(body.ok).toBe(true);
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.rulesMd).toBe('1. Be respectful.');
      expect(body.data.enabled).toBe(true);

      const row = await prisma.joinGate.findUniqueOrThrow({ where: { serverId } });
      expect(row.rulesMd).toBe('1. Be respectful.');
      expect(row.enabled).toBe(true);
      const questions = row.questionsJson as Array<{ id: string; label: string }>;
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe('age');
    } finally {
      await app.close();
    }
  });

  it('PUT .../join-gate updates an existing gate (upsert behaviour); values replaced', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    await makeJoinGate(serverId, { rulesMd: 'Old rules.', enabled: false });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { rulesMd: 'New rules.', questionsJson: [], enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateDto>;
      expect(body.data.rulesMd).toBe('New rules.');
      expect(body.data.enabled).toBe(true);

      const row = await prisma.joinGate.findUniqueOrThrow({ where: { serverId } });
      expect(row.rulesMd).toBe('New rules.');
      expect(row.enabled).toBe(true);
      // Only one row per server.
      const count = await prisma.joinGate.count({ where: { serverId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('PUT defaults: omitted fields use zod defaults (empty rulesMd, empty questions, disabled)', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      // Send an empty object; all fields have zod defaults.
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateDto>;
      expect(body.data.rulesMd).toBe('');
      expect(body.data.enabled).toBe(false);
      expect(body.data.questionsJson).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_SERVER_SAFETY_POLICY can PUT the join gate (200)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId } = await makeServer(
      ownerId,
      Permission.MANAGE_SERVER_SAFETY_POLICY,
    );
    await addMember(serverId, modId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { rulesMd: 'Mod rules.', questionsJson: [], enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.joinGate.findUniqueOrThrow({ where: { serverId } });
      expect(row.rulesMd).toBe('Mod rules.');
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_SERVER_SAFETY_POLICY cannot PUT the join gate (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/join-gate`,
        headers: { authorization: `Bearer ${token}` },
        payload: { rulesMd: 'Unauthorized.', questionsJson: [], enabled: true },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.joinGate.findUnique({ where: { serverId } });
      expect(row).toBeNull(); // no gate was created
    } finally {
      await app.close();
    }
  });

  it('PUT .../join-gate without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${ulid()}/join-gate`,
        payload: { rulesMd: 'Anon.', questionsJson: [], enabled: false },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:id/join-gate/answers ---------------------------

  it('a server member can submit answers (201); DB row upserted', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/answers`,
        headers: { authorization: `Bearer ${token}` },
        payload: { answersJson: { age: 'Yes, 25.', reason: 'Love TTRPG.' } },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<JoinGateAnswerDto>;
      expect(body.ok).toBe(true);
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.userId).toBe(memberId);
      expect(body.data.approved).toBe(false);

      const row = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      expect((row.answersJson as Record<string, string>)['age']).toBe('Yes, 25.');
    } finally {
      await app.close();
    }
  });

  it('re-submitting answers resets reviewedAt and approved (upsert idempotency)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });
    // Seed a previously-reviewed answer.
    await prisma.joinGateAnswer.create({
      data: {
        serverId,
        userId: memberId,
        answersJson: { q: 'old' } as object,
        reviewedAt: new Date(),
        reviewedBy: ownerId,
        approved: true,
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/answers`,
        headers: { authorization: `Bearer ${token}` },
        payload: { answersJson: { q: 'new answer' } },
      });
      expect(res.statusCode).toBe(201);

      const row = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      // After re-submit reviewedAt must be cleared and approved reset.
      expect(row.reviewedAt).toBeNull();
      expect(row.approved).toBe(false);
      expect((row.answersJson as Record<string, string>)['q']).toBe('new answer');
      // Still only one row.
      const count = await prisma.joinGateAnswer.count({ where: { serverId } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('POST .../join-gate/answers is 403 for a non-member', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    await makeJoinGate(serverId, { enabled: true });

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/answers`,
        headers: { authorization: `Bearer ${token}` },
        payload: { answersJson: { q: 'sneaky' } },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.joinGateAnswer.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST .../join-gate/answers is 400 when answersJson is not a record', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/answers`,
        headers: { authorization: `Bearer ${token}` },
        payload: { answersJson: 'not-an-object' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST .../join-gate/answers without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/join-gate/answers`,
        payload: { answersJson: {} },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- GET /api/servers/:id/join-gate/pending ----------------------------

  it('the owner can GET pending answers (200); reviewed answers are excluded', async () => {
    const ownerId = await makeUser('owner');
    const alice = await makeUser('alice');
    const bob = await makeUser('bob');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, alice);
    await addMember(serverId, bob);
    await makeJoinGate(serverId, { enabled: true });
    // alice = pending (no reviewedAt), bob = already reviewed.
    await makeJoinGateAnswer(serverId, alice, { q: 'pending answer' });
    await prisma.joinGateAnswer.create({
      data: {
        serverId,
        userId: bob,
        answersJson: { q: 'reviewed' } as object,
        reviewedAt: new Date(),
        reviewedBy: ownerId,
        approved: true,
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate/pending`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateAnswerDto[]>;
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.userId).toBe(alice);
    } finally {
      await app.close();
    }
  });

  it('returns empty array when all answers have been reviewed (200)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId);
    await prisma.joinGateAnswer.create({
      data: {
        serverId,
        userId: memberId,
        answersJson: {} as object,
        reviewedAt: new Date(),
        reviewedBy: ownerId,
        approved: false,
      },
    });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate/pending`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<JoinGateAnswerDto[]>;
      expect(body.data).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_MESSAGES can GET pending answers (200)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_MESSAGES);
    await addMember(serverId, modId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate/pending`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_MESSAGES cannot GET pending answers (403)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate/pending`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('a non-member cannot GET pending answers (403)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/join-gate/pending`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('GET .../join-gate/pending without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/join-gate/pending`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // ---- POST /api/servers/:id/join-gate/review/:userId --------------------

  it('the owner can approve a pending answer (200); gatePassedAt is stamped on ServerMember', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, memberId, { reason: 'I am a good person.' });

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${memberId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { approved: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ userId: string; approved: boolean }>;
      expect(body.ok).toBe(true);
      expect(body.data.userId).toBe(memberId);
      expect(body.data.approved).toBe(true);

      // JoinGateAnswer should be reviewed.
      const answer = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      expect(answer.approved).toBe(true);
      expect(answer.reviewedAt).not.toBeNull();
      expect(answer.reviewedBy).toBe(ownerId);

      // ServerMember gatePassedAt should be stamped.
      const member = await prisma.serverMember.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      expect(member.gatePassedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('the owner can deny a pending answer (200); gatePassedAt is NOT stamped', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${memberId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { approved: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ userId: string; approved: boolean }>;
      expect(body.data.approved).toBe(false);

      const answer = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      expect(answer.approved).toBe(false);
      expect(answer.reviewedAt).not.toBeNull();

      // gatePassedAt must NOT be set on denial.
      const member = await prisma.serverMember.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: memberId } },
      });
      expect(member.gatePassedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_MESSAGES can review an answer (200)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const applicantId = await makeUser('applicant');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_MESSAGES);
    await addMember(serverId, modId);
    await addMember(serverId, applicantId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, applicantId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${applicantId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { approved: true },
      });
      expect(res.statusCode).toBe(200);
      const answer = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: applicantId } },
      });
      expect(answer.reviewedBy).toBe(modId);
    } finally {
      await app.close();
    }
  });

  it('a member WITHOUT MANAGE_MESSAGES cannot review (403); answer unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const applicantId = await makeUser('applicant');
    const { serverId } = await makeServer(ownerId); // default perms only
    await addMember(serverId, memberId);
    await addMember(serverId, applicantId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, applicantId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${applicantId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { approved: true },
      });
      expect(res.statusCode).toBe(403);

      // Answer must remain unreviewed.
      const answer = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: applicantId } },
      });
      expect(answer.reviewedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('POST .../review/:userId without a token is 401', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/join-gate/review/${ulid()}`,
        payload: { approved: true },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST .../review/:userId is 400 when body is missing the approved field', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${memberId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}, // missing `approved`
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('reviewer ids are correctly recorded: reviewedBy matches the token owner', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const applicantId = await makeUser('applicant');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_MESSAGES);
    await addMember(serverId, modId);
    await addMember(serverId, applicantId);
    await makeJoinGate(serverId, { enabled: true });
    await makeJoinGateAnswer(serverId, applicantId);

    const app = await buildTestApp();
    try {
      const modToken = await mintToken(modId);
      await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/join-gate/review/${applicantId}`,
        headers: { authorization: `Bearer ${modToken}` },
        payload: { approved: false },
      });

      const answer = await prisma.joinGateAnswer.findUniqueOrThrow({
        where: { serverId_userId: { serverId, userId: applicantId } },
      });
      expect(answer.reviewedBy).toBe(modId);
    } finally {
      await app.close();
    }
  });
});
