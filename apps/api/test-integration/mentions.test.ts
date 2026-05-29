/**
 * Integration coverage for `apps/api/src/services/mentions-service.ts`.
 *
 * The service is exercised indirectly through the message-send route
 * (POST /api/channels/:id/messages), which calls `parseMentions` →
 * `resolveMentionRecipients` → `writeMentionRecords` inside the same
 * transaction as the message insert.
 *
 * Mention token syntax (from packages/shared/src/parsing/mentions.ts):
 *   @everyone / @here    → group mention (kind: 'group')
 *   @<word>              → name mention resolved to a role name or member
 *                          displayName/username (kind: 'name')
 *   @<word>@<host.tld>   → qualified federation mention (no UserMention row)
 *
 * The regex requires `@` to follow start-of-string, whitespace, or `([{`, so
 * mid-word `@` (e.g. emails) is NOT a mention. All name/group tokens must be
 * preceded by a word boundary / whitespace in test payloads.
 *
 * Covered scenarios:
 *   1.  No mentions → no UserMention rows created.
 *   2.  @<username> mention → one UserMention row (kind: 'user').
 *   3.  Self-mention → excluded (author never gets a UserMention row).
 *   4.  Duplicate name in one message → deduplicated to a single row.
 *   5.  @<roleName> mention → all role holders get UserMention rows (kind:'role').
 *   6.  @everyone → all server members (excluding author) get rows (kind: 'everyone').
 *   7.  @everyone without MENTION_EVERYONE perm → 403, no message/mention row.
 *   8.  @here → only members with active/idle presence get rows (kind: 'here').
 *   9.  Mentioning a non-existent / non-member name → no rows, no 500.
 *   10. UserChannelReadState.mentionCount is incremented for each recipient.
 *   11. @everyone wins over @here in the same message (stronger rank).
 *   12. @<username> mention for a user who has a matching displayName.
 *   13. Non-mentionable role without MENTION_EVERYONE → 403.
 *   14. No-token request → 401.
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
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeUser(
  slug: string,
  opts: { displayName?: string; presence?: string } = {},
): Promise<string> {
  const id = ulid();
  const uname = `${slug}-${id.slice(-6).toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username: uname,
      usernameLower: uname,
      displayName: opts.displayName ?? uname,
      email: `${uname}@example.test`,
      emailLower: `${uname}@example.test`,
      passwordHash: 'x',
      ...(opts.presence ? { presence: opts.presence } : {}),
    },
  });
  return id;
}

interface ServerFixture {
  serverId: string;
  everyoneRoleId: string;
  channelId: string;
}

/**
 * Server owned by `ownerId` with an @everyone role and one text channel.
 * `extraPerms` is OR-ed onto the default @everyone bitset, e.g. to grant
 * MENTION_EVERYONE to all members.
 */
async function makeServerWithChannel(
  ownerId: string,
  extraPerms = 0n,
): Promise<ServerFixture> {
  const serverId = ulid();
  const everyoneRoleId = ulid();
  const channelId = ulid();
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name: 'Mention Tavern' },
  });
  await prisma.role.create({
    data: {
      id: everyoneRoleId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE | extraPerms),
      ),
    },
  });
  await prisma.server.update({
    where: { id: serverId },
    data: { defaultRoleId: everyoneRoleId },
  });
  await prisma.channel.create({
    data: { id: channelId, serverId, type: 'text', name: 'general' },
  });
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  return { serverId, everyoneRoleId, channelId };
}

async function addMember(serverId: string, userId: string): Promise<void> {
  await prisma.serverMember.create({ data: { serverId, userId } });
}

async function makeRole(
  serverId: string,
  name: string,
  opts: { mentionable?: boolean } = {},
): Promise<string> {
  const id = ulid();
  await prisma.role.create({
    data: {
      id,
      serverId,
      name,
      permissions: new Prisma.Decimal('0'),
      mentionable: opts.mentionable ?? true,
    },
  });
  return id;
}

async function assignRole(
  serverId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await prisma.serverMemberRole.create({ data: { serverId, userId, roleId } });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!dockerOk)('POST /api/channels/:id/messages — mention side-effects', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await resetDb(prisma);
  });

  // -------------------------------------------------------------------------
  // 1. No mention in message body → no UserMention rows
  // -------------------------------------------------------------------------
  it('no mentions → no UserMention rows created', async () => {
    const aliceId = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hello world no mentions here' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      expect(mentions).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 2. @username mention → UserMention row created for that user (kind: 'user')
  // -------------------------------------------------------------------------
  it('@<username> creates a UserMention row with kind=user for the mentioned user', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      // The parser matches @word preceded by start / whitespace; prefix with a space.
      const bobUser = await prisma.user.findUniqueOrThrow({
        where: { id: bobId },
        select: { username: true },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: `hey @${bobUser.username} how are you` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.userId).toBe(bobId);
      expect(mentions[0]?.kind).toBe('user');
      expect(mentions[0]?.channelId).toBe(channelId);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Self-mention → author is excluded from UserMention rows
  // -------------------------------------------------------------------------
  it('self-mention is excluded — author never receives a UserMention row', async () => {
    const aliceId = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const aliceUser = await prisma.user.findUniqueOrThrow({
        where: { id: aliceId },
        select: { username: true },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: `I am @${aliceUser.username} and I mentioned myself` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      expect(mentions).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate @username in one message → deduplicated to a single row
  // -------------------------------------------------------------------------
  it('duplicate name mentions in one message produce a single UserMention row', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const bobUser = await prisma.user.findUniqueOrThrow({
        where: { id: bobId },
        select: { username: true },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        // Same name appears twice — should resolve to a single mention row.
        payload: {
          content: `@${bobUser.username} hey @${bobUser.username} wake up`,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id, userId: bobId },
      });
      expect(mentions).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 5. @<roleName> → all role holders get UserMention rows (kind: 'role')
  // -------------------------------------------------------------------------
  it('@<roleName> creates UserMention rows for all role holders (kind=role)', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const carolId = await makeUser('carol');
    // extraPerms: grant MENTION_EVERYONE so role mentions are allowed without gating.
    const { serverId, channelId } = await makeServerWithChannel(
      aliceId,
      Permission.MENTION_EVERYONE,
    );
    await addMember(serverId, bobId);
    await addMember(serverId, carolId);
    const roleId = await makeRole(serverId, 'Rangers', { mentionable: true });
    await assignRole(serverId, bobId, roleId);
    await assignRole(serverId, carolId, roleId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'attention @Rangers your quest begins' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
        orderBy: { userId: 'asc' },
      });
      const recipientIds = mentions.map((m) => m.userId).sort();
      expect(recipientIds).toEqual([bobId, carolId].sort());
      expect(mentions.every((m) => m.kind === 'role')).toBe(true);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 6. @everyone → all server members (excluding author) get rows
  // -------------------------------------------------------------------------
  it('@everyone creates UserMention rows (kind=everyone) for all members except the author', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const carolId = await makeUser('carol');
    // Grant MENTION_EVERYONE so the permission gate passes.
    const { serverId, channelId } = await makeServerWithChannel(
      aliceId,
      Permission.MENTION_EVERYONE,
    );
    await addMember(serverId, bobId);
    await addMember(serverId, carolId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: '@everyone important announcement' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      // Author (alice) must be excluded.
      const recipientIds = mentions.map((m) => m.userId).sort();
      expect(recipientIds).toEqual([bobId, carolId].sort());
      expect(mentions.every((m) => m.kind === 'everyone')).toBe(true);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 7. @everyone without MENTION_EVERYONE → 403, no message or mention row
  // -------------------------------------------------------------------------
  it('@everyone without MENTION_EVERYONE permission returns 403 and creates no rows', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    // Default @everyone does NOT include MENTION_EVERYONE.
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      // Send as the plain member bob — alice is the owner (ADMINISTRATOR) and
      // would bypass the MENTION_EVERYONE gate (messages.ts), masking the 403.
      const token = await mintToken(bobId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: '@everyone please listen' },
      });
      expect(res.statusCode).toBe(403);
      // No message row should have been inserted.
      const messageCount = await prisma.message.count({ where: { channelId } });
      expect(messageCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 8. @here → only members with active/idle presence get rows (kind: 'here')
  // -------------------------------------------------------------------------
  it('@here creates UserMention rows only for active/idle members (kind=here)', async () => {
    const aliceId = await makeUser('alice', { presence: 'active' });
    const bobId = await makeUser('bob', { presence: 'active' });
    const carolId = await makeUser('carol', { presence: 'offline' });
    const daveId = await makeUser('dave', { presence: 'idle' });
    const { serverId, channelId } = await makeServerWithChannel(
      aliceId,
      Permission.MENTION_EVERYONE,
    );
    await addMember(serverId, bobId);
    await addMember(serverId, carolId);
    await addMember(serverId, daveId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: '@here anyone online?' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      const recipientIds = mentions.map((m) => m.userId).sort();
      // bob (active) and dave (idle) qualify; carol (offline) does not.
      // alice (author, active) is excluded.
      expect(recipientIds).toEqual([bobId, daveId].sort());
      expect(mentions.every((m) => m.kind === 'here')).toBe(true);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 9. Mentioning a non-existent / non-member name → no rows, no 500
  // -------------------------------------------------------------------------
  it('mentioning a non-existent or non-member name produces no rows and returns 201', async () => {
    const aliceId = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hey @nobody_here_1234 are you real?' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      expect(mentions).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 10. UserChannelReadState.mentionCount is incremented per recipient
  // -------------------------------------------------------------------------
  it('mentionCount is incremented in UserChannelReadState for each recipient', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const bobUser = await prisma.user.findUniqueOrThrow({
        where: { id: bobId },
        select: { username: true },
      });

      // First mention of bob.
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: `@${bobUser.username} first ping` },
      });
      expect(res1.statusCode).toBe(201);

      const state1 = await prisma.userChannelReadState.findUnique({
        where: { userId_channelId: { userId: bobId, channelId } },
      });
      expect(state1?.mentionCount).toBe(1);

      // Second mention of bob in the same channel.
      const res2 = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: `@${bobUser.username} second ping` },
      });
      expect(res2.statusCode).toBe(201);

      const state2 = await prisma.userChannelReadState.findUnique({
        where: { userId_channelId: { userId: bobId, channelId } },
      });
      expect(state2?.mentionCount).toBe(2);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 11. @everyone wins over @here (stronger rank) when both appear in a message
  // -------------------------------------------------------------------------
  it('@everyone + @here in same message — offline member gets kind=everyone not here', async () => {
    const aliceId = await makeUser('alice', { presence: 'active' });
    const bobId = await makeUser('bob', { presence: 'offline' });
    const { serverId, channelId } = await makeServerWithChannel(
      aliceId,
      Permission.MENTION_EVERYONE,
    );
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: '@everyone and @here listen up' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      // Bob is offline so @here alone wouldn't reach him; but @everyone does.
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id, userId: bobId },
      });
      expect(mentions).toHaveLength(1);
      // @everyone (rank 4) > @here (rank 3) — bob's row must be 'everyone'.
      expect(mentions[0]?.kind).toBe('everyone');
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 12. @<displayName> mention (name differs from username)
  // -------------------------------------------------------------------------
  it('@<displayName> resolves to the correct user when displayName differs from username', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob', { displayName: 'Robert_the_Brave' });
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'well fought @Robert_the_Brave' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id },
      });
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.userId).toBe(bobId);
      expect(mentions[0]?.kind).toBe('user');
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 13. Non-mentionable role without MENTION_EVERYONE → 403
  // -------------------------------------------------------------------------
  it('mentioning a non-mentionable role without MENTION_EVERYONE returns 403', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    // Default perms — no MENTION_EVERYONE.
    const { serverId, channelId } = await makeServerWithChannel(aliceId);
    await addMember(serverId, bobId);
    // Create a role that is explicitly NOT mentionable.
    await makeRole(serverId, 'Mods', { mentionable: false });
    const app = await buildTestApp();
    try {
      // Send as the plain member bob — alice (owner) has ADMINISTRATOR and
      // bypasses the role-mention gate, masking the 403.
      const token = await mintToken(bobId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: 'hey @Mods come look at this' },
      });
      expect(res.statusCode).toBe(403);
      const messageCount = await prisma.message.count({ where: { channelId } });
      expect(messageCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // 14. Unauthenticated request → 401
  // -------------------------------------------------------------------------
  it('unauthenticated request returns 401', async () => {
    const aliceId = await makeUser('alice');
    const { channelId } = await makeServerWithChannel(aliceId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        payload: { content: '@everyone hello' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Bonus: role mention preferred over user mention when same name matches both
  // The service checks roles first; if the name matches a role, it does NOT
  // fall through to the user name lookup for that name. So a user whose
  // username equals a role name gets the 'role' kind, not 'user'.
  // -------------------------------------------------------------------------
  it('when @<name> matches a role, role holders receive kind=role (role takes priority over user name)', async () => {
    const aliceId = await makeUser('alice');
    const bobId = await makeUser('bob');
    const { serverId, channelId } = await makeServerWithChannel(
      aliceId,
      Permission.MENTION_EVERYONE,
    );
    await addMember(serverId, bobId);
    const bobUser = await prisma.user.findUniqueOrThrow({
      where: { id: bobId },
      select: { username: true },
    });
    // Create a role whose name matches bob's username.
    const roleId = await makeRole(serverId, bobUser.username, { mentionable: true });
    await assignRole(serverId, bobId, roleId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(aliceId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${token}` },
        payload: { content: `hey @${bobUser.username}` },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ id: string }>;
      const mentions = await prisma.userMention.findMany({
        where: { messageId: body.data.id, userId: bobId },
      });
      expect(mentions).toHaveLength(1);
      // Role match takes priority; even though bob's username matches, the
      // service only adds him as a role holder — not via the user lookup.
      expect(mentions[0]?.kind).toBe('role');
    } finally {
      await app.close();
    }
  });
});
