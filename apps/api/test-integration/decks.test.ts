/**
 * Integration coverage for the server-scoped card deck surface in
 * `apps/api/src/routes/decks.ts` against a real Postgres (testcontainers)
 * driven in-process via `app.inject`.
 *
 * Auth + permission model:
 *   - every handler resolves the caller via `app.requireUser` → 401 when absent
 *   - GET  /api/servers/:id/decks         requires VIEW_CHANNEL  (in PERMISSION_DEFAULT_EVERYONE)
 *   - POST /api/servers/:id/decks         requires MANAGE_EMOJIS (not in @everyone)
 *   - PATCH  /api/decks/:id              requires MANAGE_EMOJIS  (not in @everyone)
 *   - DELETE /api/decks/:id              requires MANAGE_EMOJIS  (not in @everyone)
 *   - POST  /api/decks/:id/draw          requires VIEW_CHANNEL   (in PERMISSION_DEFAULT_EVERYONE)
 *     - with channelId (non-private) additionally requires SEND_MESSAGES (in default @everyone)
 *
 *   Server owners bypass all permission checks.
 *   A plain @everyone member (no extra perms) can GET + draw but cannot create/patch/delete.
 *
 * Federation is off — no outbound queue touched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { PERMISSION_DEFAULT_EVERYONE, Permission, serializePermissions, ulid } from '@tavern/shared';
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
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Deck Tavern' } });
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
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'table' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Seed a deck directly (used to set up PATCH/DELETE/draw fixtures). */
async function makeDeck(
  serverId: string,
  createdBy: string,
  name = 'Test Deck',
  cards = [{ id: 'c1', label: 'Card One' }, { id: 'c2', label: 'Card Two' }],
): Promise<string> {
  const id = ulid();
  await prisma.cardDeck.create({
    data: {
      id,
      serverId,
      name,
      description: null,
      cardsJson: cards,
      createdBy,
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

describe.skipIf(!dockerOk)('card deck routes (apps/api/src/routes/decks.ts)', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.cardDeck.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  // ── GET /api/servers/:id/decks ─────────────────────────────────────────────

  it('lists decks for a server member (200), ordered newest-first', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const id1 = await makeDeck(serverId, ownerId, 'Alpha');
    // Brief pause so updatedAt differs enough for ordering
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await makeDeck(serverId, ownerId, 'Beta');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<Array<{ id: string; name: string; serverId: string }>>;
      expect(body.ok).toBe(true);
      expect(body.data.length).toBe(2);
      // Newest first (createdAt desc)
      expect(body.data[0]?.id).toBe(id2);
      expect(body.data[1]?.id).toBe(id1);
      expect(body.data[0]?.serverId).toBe(serverId);
    } finally {
      await app.close();
    }
  });

  it('returns an empty array when no decks exist', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<unknown[]>;
      expect(body.data).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:id/decks is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${ulid()}/decks`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('GET /api/servers/:id/decks is 403 for a non-member (lacks VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    // outsider is NOT a server member → no permissions at all

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  // ── POST /api/servers/:id/decks ────────────────────────────────────────────

  it('the server owner can create a deck (201) with persisted cards', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Action Deck',
          description: 'For dramatic moments',
          cards: [
            { id: 'a1', label: 'Strike', body: 'Deal damage' },
            { id: 'a2', label: 'Dodge' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{
        id: string;
        serverId: string;
        name: string;
        description: string | null;
        cards: Array<{ id: string; label: string }>;
        createdBy: string;
        createdAt: string;
        updatedAt: string;
      }>;
      expect(body.ok).toBe(true);
      expect(body.data.name).toBe('Action Deck');
      expect(body.data.description).toBe('For dramatic moments');
      expect(body.data.serverId).toBe(serverId);
      expect(body.data.createdBy).toBe(ownerId);
      expect(body.data.cards).toHaveLength(2);
      expect(body.data.cards[0]?.label).toBe('Strike');

      // DB row written
      const row = await prisma.cardDeck.findUniqueOrThrow({ where: { id: body.data.id } });
      expect(row.name).toBe('Action Deck');
    } finally {
      await app.close();
    }
  });

  it('a member with MANAGE_EMOJIS can create a deck (201)', async () => {
    const ownerId = await makeUser('owner');
    const modId = await makeUser('mod');
    const { serverId } = await makeServer(ownerId, Permission.MANAGE_EMOJIS);
    await addMember(serverId, modId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(modId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Mod Deck',
          cards: [{ id: 'm1', label: 'Card M' }],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ createdBy: string }>;
      expect(body.data.createdBy).toBe(modId);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot create a deck (403), no row written', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId); // default @everyone, no MANAGE_EMOJIS
    await addMember(serverId, memberId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Forbidden', cards: [{ id: 'x1', label: 'Nope' }] },
      });
      expect(res.statusCode).toBe(403);
      const count = await prisma.cardDeck.count({ where: { serverId } });
      expect(count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/decks is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${ulid()}/decks`,
        payload: { name: 'Ghost', cards: [{ id: 'g1', label: 'Ghost card' }] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/decks is 400 when name is missing', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { cards: [{ id: 'c1', label: 'Card' }] }, // missing name
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/decks is 400 when cards array is empty', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Empty', cards: [] }, // min(1) fails
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('POST /api/servers/:id/decks is 400 when card ids are not unique', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/decks`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          name: 'Duped',
          cards: [
            { id: 'dup', label: 'One' },
            { id: 'dup', label: 'Two' }, // same id → 400
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── PATCH /api/decks/:id ───────────────────────────────────────────────────

  it('the owner can patch a deck name (200) and the change persists', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Old Name');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'New Name' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string; name: string }>;
      expect(body.data.name).toBe('New Name');

      const row = await prisma.cardDeck.findUniqueOrThrow({ where: { id: deckId } });
      expect(row.name).toBe('New Name');
    } finally {
      await app.close();
    }
  });

  it('PATCH can update cards only — name/description unchanged', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Stable', [{ id: 'c1', label: 'Orig' }]);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { cards: [{ id: 'c1', label: 'Updated' }, { id: 'c2', label: 'New' }] },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ name: string; cards: Array<{ label: string }> }>;
      expect(body.data.name).toBe('Stable');
      expect(body.data.cards).toHaveLength(2);
      expect(body.data.cards[0]?.label).toBe('Updated');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/decks/:id is 404 for an unknown deck', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/decks/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${ulid()}`,
        payload: { name: 'Ghost' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot patch a deck (403), name unchanged', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const deckId = await makeDeck(serverId, ownerId, 'Protected');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Hijacked' },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.cardDeck.findUniqueOrThrow({ where: { id: deckId } });
      expect(row.name).toBe('Protected');
    } finally {
      await app.close();
    }
  });

  it('PATCH /api/decks/:id is 400 when updated card ids are not unique', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          cards: [
            { id: 'dup', label: 'A' },
            { id: 'dup', label: 'B' },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // ── DELETE /api/decks/:id ──────────────────────────────────────────────────

  it('the owner can delete a deck (200) and the row is gone', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Doomed');

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ id: string }>;
      expect(body.data.id).toBe(deckId);

      const row = await prisma.cardDeck.findUnique({ where: { id: deckId } });
      expect(row).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/decks/:id is 404 for an unknown deck', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/decks/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('DELETE /api/decks/:id is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/decks/${ulid()}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('a plain member (no MANAGE_EMOJIS) cannot delete a deck (403), row survives', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId } = await makeServer(ownerId);
    await addMember(serverId, memberId);
    const deckId = await makeDeck(serverId, ownerId, 'Survivor');

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/decks/${deckId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const row = await prisma.cardDeck.findUnique({ where: { id: deckId } });
      expect(row).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  // ── POST /api/decks/:id/draw ───────────────────────────────────────────────

  it('a member can draw a card (200) — result includes deckId, card, drawnBy', async () => {
    const ownerId = await makeUser('owner');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Draw Deck', [
      { id: 'd1', label: 'Ace' },
      { id: 'd2', label: 'King' },
    ]);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${deckId}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{
        deckId: string;
        deckName: string;
        card: { id: string; label: string };
        drawnBy: string;
        drawnAt: string;
        isPrivate: boolean;
      }>;
      expect(body.data.deckId).toBe(deckId);
      expect(body.data.deckName).toBe('Draw Deck');
      expect(body.data.drawnBy).toBe(ownerId);
      expect(['Ace', 'King']).toContain(body.data.card.label);
      expect(body.data.isPrivate).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('draw with isPrivate:true skips channel message posting and no message row is written', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Private Deck', [{ id: 'p1', label: 'Secret' }]);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${deckId}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId, isPrivate: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ isPrivate: boolean }>;
      expect(body.data.isPrivate).toBe(true);

      // No system message was created despite channelId being supplied
      const msgCount = await prisma.message.count({ where: { channelId } });
      expect(msgCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('draw with channelId (non-private) posts a system message in that channel', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId, 'Announce Deck', [{ id: 'a1', label: 'Fireball' }]);

    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${deckId}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId },
      });
      expect(res.statusCode).toBe(200);

      // A system message should have been written
      const msgs = await prisma.message.findMany({ where: { channelId, type: 'system' } });
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.content).toContain('Fireball');
    } finally {
      await app.close();
    }
  });

  it('draw is 404 for an unknown deck', async () => {
    const ownerId = await makeUser('owner');
    await makeServer(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${ulid()}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('draw is 401 without a token', async () => {
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${ulid()}/draw`,
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('draw is 403 for a non-member (lacks VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { serverId } = await makeServer(ownerId);
    const deckId = await makeDeck(serverId, ownerId);
    // outsider is NOT a server member

    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${deckId}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('draw with channelId on a channel the caller lacks SEND_MESSAGES on is 403', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    // @everyone has VIEW_CHANNEL but NOT SEND_MESSAGES
    const { serverId, channelId, everyoneId } = await makeServer(ownerId);
    // Strip SEND_MESSAGES from @everyone
    await prisma.role.update({
      where: { id: everyoneId },
      data: {
        permissions: new Prisma.Decimal(
          serializePermissions(
            (PERMISSION_DEFAULT_EVERYONE & ~Permission.SEND_MESSAGES) | Permission.VIEW_CHANNEL,
          ),
        ),
      },
    });
    await addMember(serverId, memberId);
    const deckId = await makeDeck(serverId, ownerId);

    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/decks/${deckId}/draw`,
        headers: { authorization: `Bearer ${token}` },
        payload: { channelId }, // non-private + channelId → needs SEND_MESSAGES
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
