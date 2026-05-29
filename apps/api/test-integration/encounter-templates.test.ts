/**
 * Integration coverage for the encounter-template surface in
 * `apps/api/src/routes/encounter-templates.ts` against a real Postgres
 * (testcontainers) driven in-process via `app.inject`.
 *
 * Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - list:        VIEW_CHANNEL on the server — any member; outsider → 403
 *   - create:      MANAGE_SESSIONS on the server; plain member → 403
 *   - delete:      MANAGE_SESSIONS; unknown template → 404
 *   - instantiate: MANAGE_SESSIONS on both the server AND the target channel;
 *                  participants from the template are sorted by initiative desc,
 *                  encounter created in-transaction; unknown template → 404
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
 * `extraEveryonePerms` is OR-ed onto the default @everyone bitset so tests
 * can grant MANAGE_SESSIONS to every member.
 */
async function makeServer(ownerId: string, extraEveryonePerms = 0n): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Template Tavern' },
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'tabletop' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

interface TemplateParticipant {
  name: string;
  initiative?: number;
  hp?: number;
  maxHp?: number;
  isPc?: boolean;
  conditions?: string[];
}

/** Seed an EncounterTemplate directly (avoids coupling fixture creation to the POST route). */
async function makeTemplate(
  serverId: string,
  ownerId: string,
  opts: {
    name?: string;
    participants?: TemplateParticipant[];
    notes?: string;
  } = {},
): Promise<string> {
  const id = ulid();
  const participants = opts.participants ?? [{ name: 'Goblin', initiative: 5 }];
  await prisma.encounterTemplate.create({
    data: {
      id,
      serverId,
      ownerId,
      name: opts.name ?? 'Goblin Ambush',
      participantsJson: participants as object,
      notes: opts.notes ?? null,
    },
  });
  return id;
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
type TemplateDto = {
  id: string;
  serverId: string;
  ownerId: string;
  name: string;
  participantsJson: unknown;
  notes: string | null;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)(
  'encounter-template routes (apps/api/src/routes/encounter-templates.ts)',
  () => {
    beforeEach(async () => {
      if (!dockerOk) return;
      await resetDb(prisma);
    });

    // ---- GET /api/servers/:id/encounter-templates -------------------------

    it('the server owner can list encounter templates (200), ordered updatedAt desc', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const tplAId = await makeTemplate(serverId, ownerId, { name: 'Alpha' });
      // Small delay ensures different updatedAt so order is deterministic.
      await new Promise((r) => setTimeout(r, 2));
      const tplBId = await makeTemplate(serverId, ownerId, { name: 'Beta' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<TemplateDto[]>;
        expect(body.ok).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        // updatedAt DESC → Beta first.
        expect(body.data[0]?.id).toBe(tplBId);
        expect(body.data[1]?.id).toBe(tplAId);
        expect(body.data.every((t) => t.serverId === serverId)).toBe(true);
      } finally {
        await app.close();
      }
    });

    it('returns an empty array when no templates exist (200)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<TemplateDto[]>;
        expect(body.data).toHaveLength(0);
      } finally {
        await app.close();
      }
    });

    it('a regular member (VIEW_CHANNEL via @everyone) can list templates (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId);
      await addMember(serverId, memberId);
      await makeTemplate(serverId, ownerId, { name: 'Visible' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<TemplateDto[]>;
        expect(body.data).toHaveLength(1);
        expect(body.data[0]?.name).toBe('Visible');
      } finally {
        await app.close();
      }
    });

    it('GET .../encounter-templates is 403 for a non-member', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);
      await makeTemplate(serverId, ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('GET .../encounter-templates without a token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'GET',
          url: `/api/servers/${ulid()}/encounter-templates`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- POST /api/servers/:id/encounter-templates ------------------------

    it('the server owner can create a template (201); body shape and DB row match', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: 'Dragon Lair',
            participants: [
              { name: 'Dragon', initiative: 20, hp: 200, maxHp: 200, isPc: false },
              { name: 'Hero', initiative: 12, hp: 50, maxHp: 50, isPc: true },
            ],
            notes: 'Beware the tail sweep.',
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<TemplateDto>;
        expect(body.ok).toBe(true);
        expect(body.data.name).toBe('Dragon Lair');
        expect(body.data.serverId).toBe(serverId);
        expect(body.data.ownerId).toBe(ownerId);
        expect(body.data.notes).toBe('Beware the tail sweep.');

        const row = await prisma.encounterTemplate.findUniqueOrThrow({
          where: { id: body.data.id },
        });
        expect(row.name).toBe('Dragon Lair');
        expect(row.ownerId).toBe(ownerId);
        expect(row.serverId).toBe(serverId);
        const parts = row.participantsJson as TemplateParticipant[];
        expect(Array.isArray(parts)).toBe(true);
        expect(parts).toHaveLength(2);
      } finally {
        await app.close();
      }
    });

    it('a member with MANAGE_SESSIONS can create a template (201)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_SESSIONS);
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: 'Bandit Camp',
            participants: [{ name: 'Bandit', initiative: 8 }],
          },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<TemplateDto>;
        expect(body.data.ownerId).toBe(memberId);
      } finally {
        await app.close();
      }
    });

    it('a member WITHOUT MANAGE_SESSIONS cannot create a template (403), no row written', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId); // default perms only
      await addMember(serverId, memberId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: 'Forbidden Dungeon',
            participants: [{ name: 'Guard', initiative: 10 }],
          },
        });
        expect(res.statusCode).toBe(403);
        const count = await prisma.encounterTemplate.count({ where: { serverId } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('a non-member cannot create a template (403)', async () => {
      const ownerId = await makeUser('owner');
      const outsiderId = await makeUser('outsider');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(outsiderId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: {
            name: 'Trespass',
            participants: [{ name: 'Thief', initiative: 14 }],
          },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await app.close();
      }
    });

    it('POST .../encounter-templates is 400 when participants is empty (min(1) fails)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Empty', participants: [] },
        });
        expect(res.statusCode).toBe(400);
        const count = await prisma.encounterTemplate.count({ where: { serverId } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('POST .../encounter-templates is 400 when name is empty string (min(1) fails)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: '', participants: [{ name: 'Mob', initiative: 5 }] },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST .../encounter-templates is 400 when a participant name is empty (min(1) fails)', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${serverId}/encounter-templates`,
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'Bad Mob', participants: [{ name: '' }] },
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('POST .../encounter-templates without a token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/servers/${ulid()}/encounter-templates`,
          payload: { name: 'Anon', participants: [{ name: 'Ghost', initiative: 5 }] },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- DELETE /api/encounter-templates/:id ------------------------------

    it('the server owner can delete a template (200); the row is gone', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const tplId = await makeTemplate(serverId, ownerId, { name: 'Doomed' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/encounter-templates/${tplId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as OkBody<{ id: string }>;
        expect(body.data.id).toBe(tplId);

        const row = await prisma.encounterTemplate.findUnique({ where: { id: tplId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a member with MANAGE_SESSIONS can delete a template (200)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId, Permission.MANAGE_SESSIONS);
      await addMember(serverId, memberId);
      const tplId = await makeTemplate(serverId, ownerId, { name: 'Deletable' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/encounter-templates/${tplId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);

        const row = await prisma.encounterTemplate.findUnique({ where: { id: tplId } });
        expect(row).toBeNull();
      } finally {
        await app.close();
      }
    });

    it('a member WITHOUT MANAGE_SESSIONS cannot delete a template (403); row survives', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId } = await makeServer(ownerId); // default perms only
      await addMember(serverId, memberId);
      const tplId = await makeTemplate(serverId, ownerId, { name: 'Protected' });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/encounter-templates/${tplId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);

        const row = await prisma.encounterTemplate.findUnique({ where: { id: tplId } });
        expect(row).not.toBeNull();
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/encounter-templates/:id is 404 for an unknown template', async () => {
      const ownerId = await makeUser('owner');
      await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/encounter-templates/${ulid()}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('DELETE /api/encounter-templates/:id without a token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'DELETE',
          url: `/api/encounter-templates/${ulid()}`,
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    // ---- POST /api/encounter-templates/:id/instantiate --------------------

    it(
      'the owner can instantiate a template (201); participants sorted by initiative desc, encounter row created',
      async () => {
        const ownerId = await makeUser('owner');
        const { serverId, channelId } = await makeServer(ownerId);
        const tplId = await makeTemplate(serverId, ownerId, {
          name: 'Spider Cave',
          participants: [
            { name: 'Spider Queen', initiative: 3 },
            { name: 'Rogue', initiative: 18 },
            { name: 'Fighter', initiative: 12 },
          ],
        });

        const app = await buildTestApp();
        try {
          const token = await mintToken(ownerId);
          const res = await app.inject({
            method: 'POST',
            url: `/api/encounter-templates/${tplId}/instantiate`,
            headers: { authorization: `Bearer ${token}` },
            payload: { channelId, encounterName: 'Live Spider Cave' },
          });
          expect(res.statusCode).toBe(201);
          const body = res.json() as OkBody<{ id: string }>;
          expect(typeof body.data.id).toBe('string');

          const encounter = await prisma.initiativeEncounter.findUniqueOrThrow({
            where: { id: body.data.id },
          });
          expect(encounter.channelId).toBe(channelId);
          expect(encounter.name).toBe('Live Spider Cave');

          const participants = await prisma.initiativeParticipant.findMany({
            where: { encounterId: body.data.id },
            orderBy: { position: 'asc' },
          });
          // Sorted by initiative desc: Rogue(18), Fighter(12), Spider Queen(3).
          expect(participants[0]?.name).toBe('Rogue');
          expect(participants[1]?.name).toBe('Fighter');
          expect(participants[2]?.name).toBe('Spider Queen');
          expect(participants.map((p) => p.position)).toEqual([0, 1, 2]);
        } finally {
          await app.close();
        }
      },
    );

    it('instantiate defaults encounterName to the template name when omitted', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServer(ownerId);
      const tplId = await makeTemplate(serverId, ownerId, {
        name: 'Default Name Template',
        participants: [{ name: 'Skeleton', initiative: 7 }],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string }>;

        const encounter = await prisma.initiativeEncounter.findUniqueOrThrow({
          where: { id: body.data.id },
        });
        expect(encounter.name).toBe('Default Name Template');
      } finally {
        await app.close();
      }
    });

    it('instantiate creates encounter with no participants when template participantsJson is empty array', async () => {
      const ownerId = await makeUser('owner');
      const { serverId, channelId } = await makeServer(ownerId);
      // Directly insert a template with empty participants (bypasses the min(1) create validation).
      const emptyTplId = ulid();
      await prisma.encounterTemplate.create({
        data: {
          id: emptyTplId,
          serverId,
          ownerId,
          name: 'Empty Template',
          participantsJson: [] as object,
        },
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${emptyTplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId },
        });
        expect(res.statusCode).toBe(201);
        const body = res.json() as OkBody<{ id: string }>;

        const count = await prisma.initiativeParticipant.count({
          where: { encounterId: body.data.id },
        });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('a member with MANAGE_SESSIONS can instantiate a template (201)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId } = await makeServer(ownerId, Permission.MANAGE_SESSIONS);
      await addMember(serverId, memberId);
      const tplId = await makeTemplate(serverId, ownerId, {
        participants: [{ name: 'Rat', initiative: 2 }],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId },
        });
        expect(res.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    });

    it('a member WITHOUT MANAGE_SESSIONS cannot instantiate (403)', async () => {
      const ownerId = await makeUser('owner');
      const memberId = await makeUser('member');
      const { serverId, channelId } = await makeServer(ownerId); // default perms only
      await addMember(serverId, memberId);
      const tplId = await makeTemplate(serverId, ownerId, {
        participants: [{ name: 'Imp', initiative: 9 }],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(memberId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId },
        });
        expect(res.statusCode).toBe(403);
        const count = await prisma.initiativeEncounter.count({ where: { channelId } });
        expect(count).toBe(0);
      } finally {
        await app.close();
      }
    });

    it('instantiate is 404 for an unknown template', async () => {
      const ownerId = await makeUser('owner');
      const { channelId } = await makeServer(ownerId);

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${ulid()}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId },
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('instantiate is 400 when channelId is missing from body', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const tplId = await makeTemplate(serverId, ownerId, {
        participants: [{ name: 'Mob', initiative: 5 }],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: {}, // channelId required by idSchema
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    });

    it('instantiate without a token is 401', async () => {
      const app = await buildTestApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${ulid()}/instantiate`,
          payload: { channelId: ulid() },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('instantiate is 404 when the target channel does not exist', async () => {
      const ownerId = await makeUser('owner');
      const { serverId } = await makeServer(ownerId);
      const tplId = await makeTemplate(serverId, ownerId, {
        participants: [{ name: 'Ghost', initiative: 5 }],
      });

      const app = await buildTestApp();
      try {
        const token = await mintToken(ownerId);
        const res = await app.inject({
          method: 'POST',
          url: `/api/encounter-templates/${tplId}/instantiate`,
          headers: { authorization: `Bearer ${token}` },
          payload: { channelId: ulid() }, // nonexistent channel
        });
        expect(res.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  },
);
