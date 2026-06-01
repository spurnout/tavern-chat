/**
 * Integration coverage for onboarding routes (`apps/api/src/routes/onboarding.ts`).
 *
 *   GET  /api/servers/:id/onboarding           — default shape + configured
 *   PUT  /api/servers/:id/onboarding           — config upsert (MANAGE_SERVER)
 *   PUT  /api/servers/:id/onboarding/prompts   — replace-all prompts
 *   POST /api/servers/:id/onboarding/complete  — accept rules + grant roles
 *
 * Federation is off. The owner is used for admin actions (all permissions).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

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

async function makeServer(ownerId: string): Promise<string> {
  const serverId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Onboard Tavern' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return serverId;
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({ data: { id: ulid(), userId, label: 'test', tokenHash: hash } });
  return raw;
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

describe.skipIf(!dockerOk)('Onboarding routes', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.onboardingPromptOption.deleteMany({});
    await prisma.onboardingPrompt.deleteMany({});
    await prisma.serverOnboarding.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('returns a disabled default when nothing is configured', async () => {
    const owner = await makeUser('owner');
    const serverId = await makeServer(owner);
    const app = await buildTestApp();
    try {
      const token = await mintToken(owner);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/onboarding`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const dto = (res.json() as OkBody<{ enabled: boolean; prompts: unknown[] }>).data;
      expect(dto.enabled).toBe(false);
      expect(dto.prompts).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('upserts config and round-trips it', async () => {
    const owner = await makeUser('owner');
    const serverId = await makeServer(owner);
    const app = await buildTestApp();
    try {
      const token = await mintToken(owner);
      const auth = { authorization: `Bearer ${token}` };
      let res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/onboarding`,
        headers: auth,
        payload: { enabled: true, welcomeText: 'Hello', requireRules: true, recommendedRooms: [] },
      });
      expect(res.statusCode).toBe(200);

      res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/onboarding`,
        headers: auth,
      });
      const dto = (res.json() as OkBody<{ enabled: boolean; welcomeText: string; requireRules: boolean }>).data;
      expect(dto.enabled).toBe(true);
      expect(dto.welcomeText).toBe('Hello');
      expect(dto.requireRules).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('grants the chosen role on completion', async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const serverId = await makeServer(owner);
    await prisma.serverMember.create({ data: { serverId, userId: member } });
    const roleId = ulid();
    await prisma.role.create({ data: { id: roleId, serverId, name: 'Players', position: 1 } });

    const app = await buildTestApp();
    try {
      const ownerAuth = { authorization: `Bearer ${await mintToken(owner)}` };
      const memberAuth = { authorization: `Bearer ${await mintToken(member)}` };

      // Owner configures a single prompt with one role-granting option.
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/onboarding`,
        headers: ownerAuth,
        payload: { enabled: true },
      });
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/onboarding/prompts`,
        headers: ownerAuth,
        payload: {
          prompts: [
            {
              title: 'What do you play?',
              multiSelect: false,
              options: [{ label: 'Players', roleId, channelIds: [] }],
            },
          ],
        },
      });

      // Member fetches and completes, picking the option.
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/onboarding`,
        headers: memberAuth,
      });
      const dto = (getRes.json() as OkBody<{
        prompts: Array<{ id: string; options: Array<{ id: string }> }>;
      }>).data;
      const promptId = dto.prompts[0]!.id;
      const optionId = dto.prompts[0]!.options[0]!.id;

      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/onboarding/complete`,
        headers: memberAuth,
        payload: { acceptedRules: true, selections: { [promptId]: [optionId] } },
      });
      expect(res.statusCode).toBe(200);

      const assigned = await prisma.serverMemberRole.findUnique({
        where: { serverId_userId_roleId: { serverId, userId: member, roleId } },
      });
      expect(assigned).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
