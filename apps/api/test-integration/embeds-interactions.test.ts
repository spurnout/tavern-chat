/**
 * Integration coverage for parity gap #2: rich embeds via webhook, and the
 * component-interaction endpoint (built-in role-toggle).
 *
 *   POST /api/webhooks/:id/messages          — posts an embed + button row
 *   POST /api/messages/:id/interactions      — presses the button
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import { ulid, PERMISSION_ALL } from '@tavern/shared';
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

async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string }> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Embed Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: PERMISSION_ALL.toString(),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneRoleId } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  const channelId = ulid();
  await prisma.channel.create({ data: { id: channelId, serverId, name: 'general', type: 'text' } });
  return { serverId, channelId };
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

describe.skipIf(!dockerOk)('Embeds + interactions', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.apiToken.deleteMany({});
    await prisma.messageInteraction.deleteMany({});
    await prisma.message.deleteMany({});
    await prisma.webhook.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.serverMemberRole.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('posts an embed + button row via webhook and toggles a role on press', async () => {
    const owner = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(owner);
    // A self-assignable (mentionable) role.
    const roleId = ulid();
    await prisma.role.create({
      data: { id: roleId, serverId, name: 'Adventurers', mentionable: true, position: 1 },
    });

    const app = await buildTestApp();
    try {
      const ownerAuth = { authorization: `Bearer ${await mintToken(owner)}` };

      // Create a webhook on the channel.
      const whRes = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/webhooks`,
        headers: ownerAuth,
        payload: { name: 'Bot' },
      });
      const webhook = (whRes.json() as OkBody<{ id: string }>).data;

      // Post an embed + a button whose customId triggers the role toggle.
      const postRes = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${webhook.id}/messages`,
        payload: {
          content: '',
          embeds: [{ title: 'Join the party', description: 'Tap to get the role' }],
          components: [
            {
              components: [
                {
                  type: 'button',
                  style: 'primary',
                  label: 'Get role',
                  customId: `builtin:role-toggle:${roleId}`,
                },
              ],
            },
          ],
        },
      });
      expect(postRes.statusCode).toBe(201);
      const messageId = (postRes.json() as OkBody<{ messageId: string }>).data.messageId;

      // The owner presses the button.
      const press = await app.inject({
        method: 'POST',
        url: `/api/messages/${messageId}/interactions`,
        headers: ownerAuth,
        payload: { customId: `builtin:role-toggle:${roleId}`, values: [] },
      });
      expect(press.statusCode).toBe(200);
      expect((press.json() as OkBody<{ content: string }>).data.content).toContain('Adventurers');

      const assigned = await prisma.serverMemberRole.findUnique({
        where: { serverId_userId_roleId: { serverId, userId: owner, roleId } },
      });
      expect(assigned).not.toBeNull();

      // Pressing again removes it (toggle).
      await app.inject({
        method: 'POST',
        url: `/api/messages/${messageId}/interactions`,
        headers: ownerAuth,
        payload: { customId: `builtin:role-toggle:${roleId}`, values: [] },
      });
      const after = await prisma.serverMemberRole.findUnique({
        where: { serverId_userId_roleId: { serverId, userId: owner, roleId } },
      });
      expect(after).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('rejects an interaction for a customId not on the message', async () => {
    const owner = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(owner);
    const app = await buildTestApp();
    try {
      const ownerAuth = { authorization: `Bearer ${await mintToken(owner)}` };
      const msgRes = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: ownerAuth,
        payload: { content: 'plain message' },
      });
      const messageId = (msgRes.json() as OkBody<{ id: string }>).data.id;
      const press = await app.inject({
        method: 'POST',
        url: `/api/messages/${messageId}/interactions`,
        headers: ownerAuth,
        payload: { customId: 'nope', values: [] },
      });
      expect(press.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
