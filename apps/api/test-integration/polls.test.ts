/**
 * Integration coverage for the poll routes (apps/api/src/routes/polls.ts).
 *
 * Endpoints under test:
 *   POST   /api/channels/:id/polls        — create a poll (needs SEND_MESSAGES)
 *   GET    /api/polls/:id                 — read current poll state
 *   POST   /api/polls/:id/vote            — cast a vote (needs VIEW_CHANNEL)
 *   DELETE /api/polls/:id/vote/:optionId  — retract a vote
 *   POST   /api/polls/:id/close           — close (creator → VIEW_CHANNEL, else MANAGE_MESSAGES)
 *
 * What we lock in:
 *   - Create persists a system message + poll + options, returns 201 with the
 *     full DTO; question/options are sanitised.
 *   - Single-choice voting replaces a prior vote; multi-choice accumulates;
 *     myVotes / voteCount track the viewer correctly.
 *   - Unvote removes only the targeted option for the caller.
 *   - Close marks closedAt and subsequent votes 400.
 *   - Error cases: 401 unauthenticated, 404 channel/poll not-found, 403 on
 *     SEND_MESSAGES-denied create and non-creator close, 400 validation
 *     (too few options), 400 unknown option, 400 voting on a closed poll.
 *
 * Federation is off so the route never touches the outbound queue.
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

/** Server with an @everyone role (default perms include SEND_MESSAGES) + a text channel. */
async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Poll Tavern' } });
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  await prisma.channel.create({ data: { id: channelId, serverId, type: 'text', name: 'general' } });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, channelId, everyoneId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

/** Deny a permission flag on the @everyone role overwrite for a channel. */
async function denyEveryone(channelId: string, everyoneId: string, flag: bigint): Promise<void> {
  await prisma.permissionOverwrite.create({
    data: {
      id: ulid(),
      channelId,
      targetType: 'role',
      targetId: everyoneId,
      deny: new Prisma.Decimal(serializePermissions(flag)),
    },
  });
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

interface PollDto {
  id: string;
  messageId: string;
  question: string;
  multiChoice: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  options: Array<{ id: string; label: string; position: number; voteCount: number }>;
  myVotes: string[];
}

type App = Awaited<ReturnType<typeof buildTestApp>>;

/** Create a poll via the API and return its DTO. */
async function createPoll(
  app: App,
  channelId: string,
  token: string,
  overrides: Partial<{ question: string; options: string[]; multiChoice: boolean; anonymous: boolean; closesAt: string | null }> = {},
): Promise<PollDto> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${channelId}/polls`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      question: overrides.question ?? 'Favourite tavern drink?',
      options: overrides.options ?? ['Ale', 'Mead', 'Cider'],
      multiChoice: overrides.multiChoice ?? false,
      anonymous: overrides.anonymous ?? false,
      closesAt: overrides.closesAt ?? null,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createPoll failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as OkBody<{ message: unknown; poll: PollDto }>;
  return body.data.poll;
}

async function cleanup(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.pollVote.deleteMany({});
  await prisma.pollOption.deleteMany({});
  await prisma.poll.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
}

describe.skipIf(!dockerOk)('POST /api/channels/:id/polls — create', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/polls`,
        payload: { question: 'Q', options: ['a', 'b'] },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('creates a poll → 201 with full DTO + a system message, options sanitised', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/polls`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          question: 'Pick <b>one</b>',
          options: ['<i>Red</i>', 'Blue'],
          multiChoice: false,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ message: { id: string; content: string; type: string }; poll: PollDto }>;
      // HTML stripped from question + reflected in the system message content.
      expect(body.data.poll.question).toBe('Pick one');
      expect(body.data.poll.options.map((o) => o.label)).toEqual(['Red', 'Blue']);
      expect(body.data.poll.options.every((o) => o.voteCount === 0)).toBe(true);
      expect(body.data.poll.myVotes).toEqual([]);
      expect(body.data.poll.createdBy).toBe(ownerId);

      // The companion system message exists and references the poll.
      const msg = await prisma.message.findUnique({ where: { id: body.data.message.id } });
      expect(msg?.type).toBe('system');
      expect(msg?.serverId).toBe(serverId);
      expect(msg?.content).toContain('Poll:');

      const poll = await prisma.poll.findUnique({ where: { id: body.data.poll.id } });
      expect(poll?.messageId).toBe(body.data.message.id);
    } finally {
      await app.close();
    }
  });

  it('400 when fewer than two options are supplied', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/polls`,
        headers: { authorization: `Bearer ${token}` },
        payload: { question: 'Only one?', options: ['Solo'] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('400 when the question is empty', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/polls`,
        headers: { authorization: `Bearer ${token}` },
        payload: { question: '', options: ['a', 'b'] },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('404 when the channel does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${ulid()}/polls`,
        headers: { authorization: `Bearer ${token}` },
        payload: { question: 'Q', options: ['a', 'b'] },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('403 when SEND_MESSAGES is denied for the channel', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    await denyEveryone(channelId, everyoneId, Permission.SEND_MESSAGES);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/polls`,
        headers: { authorization: `Bearer ${token}` },
        payload: { question: 'Q', options: ['a', 'b'] },
      });
      // VIEW_CHANNEL still held (so not 404); SEND_MESSAGES denied → 403.
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('GET /api/polls/:id — read', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({ method: 'GET', url: `/api/polls/${poll.id}` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404 for an unknown poll id', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/polls/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('returns the poll DTO for an authenticated caller', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const created = await createPoll(app, channelId, token, { question: 'Yes or no?', options: ['Yes', 'No'] });
      const res = await app.inject({
        method: 'GET',
        url: `/api/polls/${created.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.id).toBe(created.id);
      expect(body.data.question).toBe('Yes or no?');
      expect(body.data.options).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('POST /api/polls/:id/vote — vote', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        payload: { optionId: poll.options[0]!.id },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404 when the poll does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${ulid()}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: ulid() },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('400 for an unknown option id', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: ulid() },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('records a vote and reflects it in voteCount + myVotes', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const target = poll.options[0]!;
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: target.id },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.myVotes).toContain(target.id);
      const opt = body.data.options.find((o) => o.id === target.id);
      expect(opt?.voteCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('single-choice voting replaces the previous vote', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token, { multiChoice: false });
      const [first, second] = poll.options;

      await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: first!.id },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: second!.id },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      // Old vote dropped, only the new one remains.
      expect(body.data.myVotes).toEqual([second!.id]);
      expect(body.data.options.find((o) => o.id === first!.id)?.voteCount).toBe(0);
      expect(body.data.options.find((o) => o.id === second!.id)?.voteCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('multi-choice voting accumulates multiple votes from one user', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token, { multiChoice: true });
      const [first, second] = poll.options;

      await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: first!.id },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: second!.id },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.myVotes).toContain(first!.id);
      expect(body.data.myVotes).toContain(second!.id);
      expect(body.data.myVotes).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it('re-voting the same option is idempotent (upsert, no duplicate)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token, { multiChoice: true });
      const target = poll.options[0]!;
      const vote = () =>
        app.inject({
          method: 'POST',
          url: `/api/polls/${poll.id}/vote`,
          headers: { authorization: `Bearer ${token}` },
          payload: { optionId: target.id },
        });
      await vote();
      const res = await vote();
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.options.find((o) => o.id === target.id)?.voteCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('400 when voting on a closed poll', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      await prisma.poll.update({ where: { id: poll.id }, data: { closedAt: new Date() } });
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: poll.options[0]!.id },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('400 when voting after the closesAt deadline has passed', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      await prisma.poll.update({
        where: { id: poll.id },
        data: { closesAt: new Date(Date.now() - 60_000) },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: poll.options[0]!.id },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('404 when a non-member (no VIEW_CHANNEL) tries to vote', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, ownerToken);
      const outsiderToken = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${outsiderToken}` },
        payload: { optionId: poll.options[0]!.id },
      });
      // VIEW_CHANNEL is required to vote; an outsider lacks it → resolver 404s.
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('DELETE /api/polls/:id/vote/:optionId — unvote', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/polls/${poll.id}/vote/${poll.options[0]!.id}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404 when the poll does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/polls/${ulid()}/vote/${ulid()}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('retracts the caller\'s vote for the given option', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const target = poll.options[0]!;
      await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/vote`,
        headers: { authorization: `Bearer ${token}` },
        payload: { optionId: target.id },
      });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/polls/${poll.id}/vote/${target.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.myVotes).not.toContain(target.id);
      expect(body.data.options.find((o) => o.id === target.id)?.voteCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('unvoting an option the caller never voted for is a no-op 200', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/polls/${poll.id}/vote/${poll.options[1]!.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.myVotes).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('POST /api/polls/:id/close — close', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({ method: 'POST', url: `/api/polls/${poll.id}/close` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404 when the poll does not exist', async () => {
    const ownerId = await makeUser('owner');
    await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${ulid()}/close`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('the creator can close their own poll (sets closedAt)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, token);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/close`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<PollDto>;
      expect(body.data.closedAt).not.toBeNull();

      const persisted = await prisma.poll.findUnique({ where: { id: poll.id } });
      expect(persisted?.closedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it('403 when a non-creator without MANAGE_MESSAGES tries to close', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const poll = await createPoll(app, channelId, ownerToken);

      const memberToken = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/close`,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      // Not the creator → MANAGE_MESSAGES required, which @everyone lacks → 403.
      expect(res.statusCode).toBe(403);

      const persisted = await prisma.poll.findUnique({ where: { id: poll.id } });
      expect(persisted?.closedAt).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('a non-creator WITH MANAGE_MESSAGES (the owner/admin) can close another user\'s poll', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      // Member (a plain member with SEND_MESSAGES) creates the poll.
      const memberToken = await mintToken(memberId);
      const poll = await createPoll(app, channelId, memberToken);

      // Owner has ADMINISTRATOR which satisfies MANAGE_MESSAGES → can close it.
      const ownerToken = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/polls/${poll.id}/close`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const persisted = await prisma.poll.findUnique({ where: { id: poll.id } });
      expect(persisted?.closedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
