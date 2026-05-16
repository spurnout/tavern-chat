import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  requireChannelPermission,
  requireServerPermission,
} from '../services/permissions-service.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Wave 2 #19 — API tokens, bot accounts, incoming webhooks.
 *
 * - User-scoped personal access tokens (PATs): mint via /me/tokens, revoke
 *   via DELETE. Tokens are presented once at mint and hashed at rest.
 * - Bot accounts: a User row with `isBot=true` and no password, owned by a
 *   tavern admin. Bots authenticate exclusively via API tokens.
 * - Incoming webhooks: per-channel endpoint that accepts a tiny JSON body
 *   and posts a message under the webhook's display name. Authenticated by
 *   the URL secret (constant-time compared).
 *
 * The Bearer-token middleware that actually accepts tokens for the existing
 * routes is a follow-up — it'd live in `plugins/auth.ts`. For now, tokens
 * exist, can be minted, and the webhook path is fully usable on its own.
 */

const createTokenSchema = z.object({
  label: z.string().min(1).max(60),
  expiresAt: z.string().datetime().nullable().optional(),
});

const createWebhookSchema = z.object({
  name: z.string().min(1).max(60),
});

const webhookPostSchema = z.object({
  content: z.string().min(1).max(4000),
  username: z.string().max(60).optional(),
  avatarUrl: z.string().url().max(512).optional(),
});

function makeToken(prefix: 'pat' | 'bot'): { plaintext: string; hash: string } {
  const bytes = crypto.randomBytes(24).toString('base64url');
  const plaintext = `tvn_${prefix}_${bytes}`;
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  return { plaintext, hash };
}

export async function registerTokenAndWebhookRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================================
  // API tokens
  // ============================================================================

  app.get('/api/me/tokens', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const tokens = await prisma.apiToken.findMany({
      where: { userId: ctx.userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        label: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    reply.send(
      ok(
        tokens.map((t) => ({
          id: t.id,
          label: t.label,
          scopes: t.scopes,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          expiresAt: t.expiresAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
        })),
      ),
    );
  });

  app.post('/api/me/tokens', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = createTokenSchema.parse(req.body);
    const { plaintext, hash } = makeToken('pat');
    const row = await prisma.apiToken.create({
      data: {
        id: ulid(),
        userId: ctx.userId,
        label: body.label,
        tokenHash: hash,
        scopes: [],
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    // Token plaintext is returned ONCE — never again.
    reply.status(201).send(
      ok({
        id: row.id,
        label: row.label,
        token: plaintext,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
      }),
    );
  });

  app.delete('/api/me/tokens/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.apiToken.findUnique({ where: { id } });
    if (!existing || existing.userId !== ctx.userId) {
      throw TavernError.notFound('Token not found');
    }
    await prisma.apiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    reply.send(ok({ id }));
  });

  // ============================================================================
  // Bot accounts (admin-only, per server)
  // ============================================================================

  app.post('/api/servers/:id/bots', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        username: z
          .string()
          .min(3)
          .max(32)
          .regex(/^[a-zA-Z0-9_]+$/),
        displayName: z.string().min(1).max(40),
      })
      .parse(req.body);
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_SERVER);

    const existing = await prisma.user.findUnique({
      where: { usernameLower: body.username.toLowerCase() },
    });
    if (existing) throw new TavernError('USERNAME_TAKEN', 'Username taken', 409);

    const botUserId = ulid();
    const fakeEmail = `bot+${botUserId}@bots.invalid`;
    const bot = await prisma.user.create({
      data: {
        id: botUserId,
        username: body.username,
        usernameLower: body.username.toLowerCase(),
        displayName: body.displayName,
        email: fakeEmail,
        emailLower: fakeEmail.toLowerCase(),
        // Bots have no usable password — they authenticate via API tokens.
        passwordHash: crypto.randomBytes(64).toString('hex'),
        isBot: true,
      },
    });
    // Join the bot to the tavern with the everyone role.
    const server = await prisma.server.findUniqueOrThrow({
      where: { id: serverId },
      select: { defaultRoleId: true },
    });
    await prisma.serverMember.create({
      data: { serverId, userId: bot.id },
    });
    if (server.defaultRoleId) {
      await prisma.serverMemberRole.create({
        data: {
          serverId,
          userId: bot.id,
          roleId: server.defaultRoleId,
        },
      });
    }
    // Mint an initial token.
    const { plaintext, hash } = makeToken('bot');
    await prisma.apiToken.create({
      data: {
        id: ulid(),
        userId: bot.id,
        label: 'initial',
        tokenHash: hash,
        scopes: [],
      },
    });
    reply.status(201).send(
      ok({
        bot: { id: bot.id, username: bot.username, displayName: bot.displayName },
        token: plaintext,
      }),
    );
  });

  // ============================================================================
  // Webhooks
  // ============================================================================

  app.get('/api/channels/:id/webhooks', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    const rows = await prisma.webhook.findMany({
      where: { channelId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(
      ok(
        rows.map((w) => ({
          id: w.id,
          channelId: w.channelId,
          name: w.name,
          createdBy: w.createdBy,
          createdAt: w.createdAt.toISOString(),
          lastDeliveryAt: w.lastDeliveryAt?.toISOString() ?? null,
        })),
      ),
    );
  });

  app.post('/api/channels/:id/webhooks', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = createWebhookSchema.parse(req.body);
    await requireChannelPermission(channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    const secret = crypto.randomBytes(24).toString('base64url');
    const row = await prisma.webhook.create({
      data: {
        id: ulid(),
        channelId,
        name: body.name,
        secret,
        createdBy: ctx.userId,
      },
    });
    // The plaintext secret is returned ONCE; subsequent reads omit it.
    reply.status(201).send(
      ok({
        id: row.id,
        channelId: row.channelId,
        name: row.name,
        secret,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  });

  app.delete('/api/webhooks/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const wh = await prisma.webhook.findUnique({ where: { id } });
    if (!wh) throw TavernError.notFound('Webhook not found');
    await requireChannelPermission(wh.channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    await prisma.webhook.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    reply.send(ok({ id }));
  });

  // Public webhook delivery — no JWT cookie, no user session. Auth is the
  // `?token=<secret>` query param, constant-time compared.
  app.post('/api/webhooks/:id/messages', async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const token = (req.query as { token?: string } | undefined)?.token ?? '';
    const wh = await prisma.webhook.findUnique({
      where: { id },
      include: { channel: { select: { id: true, serverId: true } } },
    });
    if (!wh || wh.revokedAt) throw TavernError.notFound('Webhook not found');

    if (
      token.length !== wh.secret.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(wh.secret))
    ) {
      throw new TavernError('UNAUTHORIZED', 'Invalid webhook secret', 401);
    }
    const body = webhookPostSchema.parse(req.body);

    const messageId = ulid();
    // Webhook messages are posted under the webhook creator's identity so
    // the message's authorId is a real user. The webhook's `name` overrides
    // the display name client-side via a (deferred) renderer extension; for
    // now we prefix the content with the webhook name to make it visible.
    const displayPrefix = (body.username ?? wh.name) + ' • ';
    const row = await prisma.message.create({
      data: {
        id: messageId,
        serverId: wh.channel.serverId,
        channelId: wh.channelId,
        authorId: wh.createdBy,
        type: 'default',
        content: displayPrefix + body.content,
      },
      include: {
        attachments: { select: { id: true } },
        reactions: { select: { emoji: true, userId: true } },
        author: { select: { id: true, displayName: true, username: true } },
        poll: { select: { id: true } },
        replyTo: {
          select: {
            id: true,
            content: true,
            deletedAt: true,
            author: { select: { displayName: true } },
          },
        },
      },
    });
    await prisma.webhook.update({
      where: { id },
      data: { lastDeliveryAt: new Date() },
    });
    gatewayBroker.publish({
      type: 'MESSAGE_CREATE',
      serverId: wh.channel.serverId,
      channelId: wh.channelId,
      data: serializeMessage(row as MessageRow, wh.createdBy),
    });
    reply.status(201).send(ok({ messageId }));
  });
}
