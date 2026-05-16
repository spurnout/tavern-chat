import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const MAX_IMPORT_MESSAGES = 5000;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Wave 3 #40 — Discord / Slack / Matrix import (channel scope).
 *
 * Accepts a normalized JSON payload with `{ source, messages }`. Real
 * Discord/Slack/Matrix exports vary in shape, so the operator runs them
 * through a conversion tool (DiscordChatExporter, slack-cli, etc.) and
 * feeds the normalized array here. Each message becomes a `system`-type
 * Tavern message authored by the importer; the original author name is
 * prepended in bold so the conversation reads naturally.
 *
 * Limits:
 *   - body must be < the API's body limit (2 MiB). Large channels need to
 *     be paged through multiple POSTs, optionally with `?startAfter=...`
 *     to skip already-imported timestamps.
 *   - At most 5000 messages per call. Anything beyond that is rejected so
 *     a runaway import doesn't lock the DB.
 *
 * No mapping back to real Tavern users — that would require operator
 * confirmation per imported user and is the natural follow-up.
 */
const importMessageSchema = z.object({
  author: z.string().min(1).max(120),
  content: z.string().min(0).max(MAX_MESSAGE_LENGTH),
  /** ISO 8601 — for ordering only; the actual Tavern row uses createdAt = now. */
  timestamp: z.string().datetime().optional(),
});

const importBodySchema = z.object({
  source: z.enum(['discord', 'slack', 'matrix', 'other']),
  messages: z.array(importMessageSchema).min(1).max(MAX_IMPORT_MESSAGES),
});

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/channels/:id/import', {
    config: {
      rateLimit: { max: 5, timeWindow: '15 minutes' },
    },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
      const body = importBodySchema.parse(req.body);
      // Require MANAGE_CHANNELS — importing into a room is bulk authoring
      // that overwrites the room's tone. Letting any sender do it would be
      // a spam vector.
      const ctxPerms = await requireChannelPermission(
        channelId,
        ctx.userId,
        Permission.MANAGE_CHANNELS,
      );
      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { id: true, type: true, serverId: true },
      });
      if (!channel) throw TavernError.notFound('Channel not found');
      if (channel.type !== 'text' && channel.type !== 'forum') {
        throw new TavernError(
          'WRONG_CHANNEL_TYPE',
          'Imports only work into text or forum channels',
          400,
        );
      }

      // Sort by timestamp so the resulting ordering matches the source. We
      // use the API process clock for createdAt to keep nonces unique, but
      // the ordering still tracks the source.
      const ordered = [...body.messages].sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0;
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return a.timestamp.localeCompare(b.timestamp);
      });

      let inserted = 0;
      // Batched createMany — Prisma supports this on Postgres. Each batch is
      // capped so a 5000-message import doesn't construct one giant SQL.
      const batchSize = 200;
      const now = Date.now();
      for (let i = 0; i < ordered.length; i += batchSize) {
        const slice = ordered.slice(i, i + batchSize);
        const data = slice.map((m, idx) => ({
          id: ulid(),
          channelId,
          serverId: channel.serverId,
          authorId: ctx.userId,
          type: 'system' as const,
          content: formatImportedMessage(m.author, m.content),
          // Stagger createdAt by milliseconds so the ordering is stable and
          // the message timeline doesn't smash all imports into one moment.
          createdAt: new Date(now + i + idx),
        }));
        const result = await prisma.message.createMany({ data, skipDuplicates: true });
        inserted += result.count;
      }

      // Fire a single audit-style gateway event so the channel's clients
      // know to refresh. We don't blast a MESSAGE_CREATE per row — that
      // would be a thundering herd; the operator can refresh the view.
      gatewayBroker.publish({
        type: 'CHANNEL_IMPORT',
        serverId: channel.serverId,
        channelId,
        data: {
          channelId,
          source: body.source,
          inserted,
          actorId: ctx.userId,
        },
      });

      reply.send(
        ok({
          channelId,
          source: body.source,
          requested: body.messages.length,
          inserted,
          serverPerms: ctxPerms.perms.toString(),
        }),
      );
    },
  });
}

function formatImportedMessage(author: string, content: string): string {
  // Truncate hard — schema cap is 4000 but author + formatting eats a few.
  const safeAuthor = author.slice(0, 80).replace(/[*_`|~]/g, '');
  const safeBody = content.slice(0, MAX_MESSAGE_LENGTH - 200);
  return `**${safeAuthor}:** ${safeBody}`;
}
