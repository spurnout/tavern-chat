/**
 * Integration coverage for the slash-command routes (apps/api/src/routes/slash.ts).
 *
 * Endpoints under test:
 *   GET  /api/channels/:id/slash/commands  — permission-aware catalog
 *   POST /api/channels/:id/slash           — execute a slash command
 *
 * What we lock in:
 *   - Catalog filters by the caller's resolved channel permissions (a plain
 *     member without MANAGE_MESSAGES / MANAGE_SESSIONS never sees /pin or
 *     /encounter; the owner — ADMINISTRATOR — sees every command).
 *   - /roll persists a DiceRoll + a dice_roll message and returns 201 {kind:'roll'}.
 *   - /me, /shrug, /tableflip, /unflip persist a default message → 201 {kind:'message'}.
 *   - clientAction commands (/poll) and not-yet-wired commands (/pin via the
 *     member who *does* hold the perm) return 200 {kind:'noop'}.
 *   - Nonce idempotency: same author replay → 200 {kind:'message'}; a different
 *     author reusing the nonce → 400 and cannot read the original.
 *   - Error cases: 401 unauthenticated, 404 channel-not-found / non-member
 *     (VIEW_CHANNEL leak guard), 403 missing the command's required permission,
 *     400 unknown command and invalid dice notation.
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

/** Server with an @everyone role (default perms include SEND_MESSAGES + ROLL_DICE) + a text channel. */
async function makeServerWithChannel(ownerId: string): Promise<{ serverId: string; channelId: string; everyoneId: string }> {
  const serverId = ulid();
  const everyoneId = ulid();
  const channelId = ulid();
  await prisma.server.create({ data: { id: serverId, ownerUserId: ownerId, name: 'Slash Tavern' } });
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

async function cleanup(): Promise<void> {
  await prisma.apiToken.deleteMany({});
  await prisma.diceRoll.deleteMany({});
  await prisma.message.deleteMany({});
  await prisma.serverMember.deleteMany({});
  await prisma.permissionOverwrite.deleteMany({});
  await prisma.role.deleteMany({});
  await prisma.channel.deleteMany({});
  await prisma.server.deleteMany({});
  await prisma.user.deleteMany({});
}

describe.skipIf(!dockerOk)('GET /api/channels/:id/slash/commands — catalog', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await cleanup();
  });

  it('401 when unauthenticated', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/channels/${channelId}/slash/commands` });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404 for a non-member (VIEW_CHANNEL leak guard) and for a missing channel', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/slash/commands`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);

      const ownerToken = await mintToken(ownerId);
      const missing = await app.inject({
        method: 'GET',
        url: `/api/channels/${ulid()}/slash/commands`,
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('a plain member sees permitted commands but NOT /pin or /encounter', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/slash/commands`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ commands: Array<{ name: string; clientAction?: string }> }>;
      const names = body.data.commands.map((c) => c.name);
      // Default @everyone holds SEND_MESSAGES + ROLL_DICE but not MANAGE_MESSAGES / MANAGE_SESSIONS.
      expect(names).toContain('roll');
      expect(names).toContain('me');
      expect(names).toContain('poll');
      expect(names).toContain('save');
      expect(names).not.toContain('pin');
      expect(names).not.toContain('encounter');
      // clientAction is surfaced for the poll entry.
      const poll = body.data.commands.find((c) => c.name === 'poll');
      expect(poll?.clientAction).toBe('open_poll_modal');
    } finally {
      await app.close();
    }
  });

  it('the owner (ADMINISTRATOR) sees every command including /pin and /encounter', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'GET',
        url: `/api/channels/${channelId}/slash/commands`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ commands: Array<{ name: string }> }>;
      const names = body.data.commands.map((c) => c.name);
      expect(names).toContain('pin');
      expect(names).toContain('encounter');
      expect(names).toContain('roll');
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!dockerOk)('POST /api/channels/:id/slash — execute', () => {
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
        url: `/api/channels/${channelId}/slash`,
        payload: { command: 'roll', args: '1d20' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('400 on a malformed body (missing command)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { args: 'no command here' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('400 for an unknown slash command', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'definitely-not-real' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('Unknown slash command');
    } finally {
      await app.close();
    }
  });

  it('403 for a non-member executing /roll (gate is on ROLL_DICE, not VIEW_CHANNEL)', async () => {
    const ownerId = await makeUser('owner');
    const outsiderId = await makeUser('outsider');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(outsiderId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'roll', args: '1d20' },
      });
      // /roll requires ROLL_DICE. The channel exists, so getChannelPermissions
      // returns PERMISSION_NONE (not null) for the outsider. The 404 leak guard
      // in requireChannelPermission only fires when the requested flag IS
      // VIEW_CHANNEL; ROLL_DICE is not, so the resolver throws forbidden → 403.
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('403 when a member lacks the command permission (/pin needs MANAGE_MESSAGES)', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'pin' },
      });
      // Member holds VIEW_CHANNEL (so no 404) but not MANAGE_MESSAGES → 403.
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('/roll persists a DiceRoll + message and returns 201 {kind:"roll"}', async () => {
    const ownerId = await makeUser('owner');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'roll', args: '2d6+3' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ kind: string; diceRollId: string; messageId: string }>;
      expect(body.data.kind).toBe('roll');

      const roll = await prisma.diceRoll.findUnique({ where: { id: body.data.diceRollId } });
      expect(roll).not.toBeNull();
      expect(roll?.serverId).toBe(serverId);
      expect(roll?.channelId).toBe(channelId);

      const msg = await prisma.message.findUnique({ where: { id: body.data.messageId } });
      expect(msg?.type).toBe('dice_roll');
      expect(msg?.diceRollId).toBe(body.data.diceRollId);
    } finally {
      await app.close();
    }
  });

  it('/roll defaults to 1d20 when no args are given', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'roll' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ diceRollId: string }>;
      const roll = await prisma.diceRoll.findUnique({ where: { id: body.data.diceRollId } });
      expect(roll?.notation).toBe('1d20');
    } finally {
      await app.close();
    }
  });

  it('400 for invalid dice notation', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'roll', args: 'not-dice!!' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('/me stores an italicised action message and returns 201 {kind:"message"}', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'me', args: 'waves hello' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ kind: string; messageId: string }>;
      expect(body.data.kind).toBe('message');
      const msg = await prisma.message.findUnique({ where: { id: body.data.messageId } });
      expect(msg?.content).toBe('* waves hello *');
      expect(msg?.type).toBe('default');
    } finally {
      await app.close();
    }
  });

  it('/shrug appends the kaomoji and returns 201', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'shrug', args: 'whatever' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as OkBody<{ messageId: string }>;
      const msg = await prisma.message.findUnique({ where: { id: body.data.messageId } });
      expect(msg?.content).toContain('¯\\_(ツ)_/¯');
      expect(msg?.content).toContain('whatever');
    } finally {
      await app.close();
    }
  });

  it('/me with no args falls through to the "coming soon" noop (renderTextCommand returns null)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'me', args: '' },
      });
      // Empty /me → renderTextCommand returns null; /me has no clientAction,
      // so the handler falls to the soft "coming soon" noop.
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ kind: string; notice?: string }>;
      expect(body.data.kind).toBe('noop');
    } finally {
      await app.close();
    }
  });

  it('clientAction command (/poll) returns 200 {kind:"noop"} steering to the composer', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'poll', args: 'fav color | red | blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ kind: string; notice?: string }>;
      expect(body.data.kind).toBe('noop');
      expect(body.data.notice).toContain('poll');
    } finally {
      await app.close();
    }
  });

  it('not-yet-wired command (/pin by an admin) returns 200 {kind:"noop"} "coming soon"', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      // Owner has ADMINISTRATOR so the permission gate passes; /pin has no
      // clientAction and isn't a text command, so it hits the soft notice.
      const token = await mintToken(ownerId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'pin' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as OkBody<{ kind: string; notice?: string }>;
      expect(body.data.kind).toBe('noop');
      expect(body.data.notice).toContain('not yet available');
    } finally {
      await app.close();
    }
  });

  it('nonce idempotency: same author replaying a slash nonce gets 200 {kind:"message"} (no duplicate)', async () => {
    const ownerId = await makeUser('owner');
    const { channelId } = await makeServerWithChannel(ownerId);
    const app = await buildTestApp();
    try {
      const token = await mintToken(ownerId);
      const post = () =>
        app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/slash`,
          headers: { authorization: `Bearer ${token}` },
          payload: { command: 'me', args: 'dances', nonce: 'SLASH-NONCE-1' },
        });

      const first = await post();
      expect(first.statusCode).toBe(201);
      const firstBody = first.json() as OkBody<{ kind: string; messageId: string }>;

      const second = await post();
      expect(second.statusCode).toBe(200);
      const secondBody = second.json() as OkBody<{ kind: string; messageId: string }>;
      expect(secondBody.data.kind).toBe('message');
      expect(secondBody.data.messageId).toBe(firstBody.data.messageId);

      const count = await prisma.message.count({ where: { channelId, nonce: 'SLASH-NONCE-1' } });
      expect(count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('nonce idempotency: a different author reusing the nonce is rejected (400)', async () => {
    const ownerId = await makeUser('owner');
    const otherId = await makeUser('other');
    const { serverId, channelId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, otherId);
    const app = await buildTestApp();
    try {
      const ownerToken = await mintToken(ownerId);
      const otherToken = await mintToken(otherId);

      const first = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { command: 'me', args: 'owner action', nonce: 'SLASH-SHARED' },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { command: 'me', args: 'other action', nonce: 'SLASH-SHARED' },
      });
      expect(second.statusCode).toBe(400);
      expect(second.body).not.toContain('owner action');

      const rows = await prisma.message.findMany({ where: { channelId, nonce: 'SLASH-SHARED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.authorId).toBe(ownerId);
    } finally {
      await app.close();
    }
  });

  it('403 when SEND_MESSAGES is denied for a text command (/me) via a channel overwrite', async () => {
    const ownerId = await makeUser('owner');
    const memberId = await makeUser('member');
    const { serverId, channelId, everyoneId } = await makeServerWithChannel(ownerId);
    await addMember(serverId, memberId);
    // Deny SEND_MESSAGES on @everyone for this channel; member keeps VIEW_CHANNEL.
    await denyEveryone(channelId, everyoneId, Permission.SEND_MESSAGES);
    const app = await buildTestApp();
    try {
      const token = await mintToken(memberId);
      const res = await app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/slash`,
        headers: { authorization: `Bearer ${token}` },
        payload: { command: 'me', args: 'tries to act' },
      });
      // /me requires SEND_MESSAGES (the catalog flag); denied → 403, not 404,
      // because VIEW_CHANNEL is still present.
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
