import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import {
  DiceParseError,
  evaluateDiceNotation,
  findSlashEntry,
  hasFlag,
  idSchema,
  Permission,
  PermissionFlags,
  SLASH_CATALOG,
  slashCatalogResponseSchema,
  slashExecuteRequestSchema,
  type SlashExecuteResponse,
  TavernError,
  ulid,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeMessage, type MessageRow } from '../lib/serializers.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

function sanitizeContent(content: string): string {
  return sanitizeHtml(content, { allowedTags: [], allowedAttributes: {} });
}

/**
 * Convert an array of PermissionFlag names to the OR'd bitset for fast checks.
 * Unknown flag names are ignored — autocomplete is a UI hint, the server-side
 * permission gate is still the source of truth.
 */
function flagsToBits(flags: ReadonlyArray<string> | undefined): bigint {
  if (!flags || flags.length === 0) return 0n;
  let bits = 0n;
  for (const f of flags) {
    if ((PermissionFlags as ReadonlyArray<string>).includes(f)) {
      bits |= Permission[f as keyof typeof Permission];
    }
  }
  return bits;
}

export async function registerSlashRoutes(app: FastifyInstance): Promise<void> {
  // List the slash commands available to the caller for this channel.
  // The frontend uses this to render permission-aware autocomplete.
  app.get('/api/channels/:id/slash/commands', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const result = await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);

    const filtered = SLASH_CATALOG.filter((entry) => {
      const need = flagsToBits(entry.requiredPermissions);
      if (need === 0n) return true;
      if (hasFlag(result.perms, Permission.ADMINISTRATOR)) return true;
      return (result.perms & need) === need;
    });

    reply.send(
      ok(
        slashCatalogResponseSchema.parse({
          commands: filtered.map((e) => ({
            name: e.name,
            description: e.description,
            argsHint: e.argsHint,
            ...(e.clientAction ? { clientAction: e.clientAction } : {}),
          })),
        }),
      ),
    );
  });

  // Execute a slash command in a channel.
  app.post('/api/channels/:id/slash', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: channelId } = z.object({ id: idSchema }).parse(req.params);
    const body = slashExecuteRequestSchema.parse(req.body);

    const entry = findSlashEntry(body.command);
    if (!entry) {
      throw TavernError.validation(`Unknown slash command: /${body.command}`);
    }

    // Permission gate — server is authoritative.
    const need = flagsToBits(entry.requiredPermissions);
    const result = await requireChannelPermission(
      channelId,
      ctx.userId,
      need === 0n ? Permission.SEND_MESSAGES : need,
    );

    // Idempotency by nonce, same shape as message create.
    if (body.nonce) {
      const existing = await prisma.message.findUnique({
        where: { channelId_nonce: { channelId, nonce: body.nonce } },
        select: { id: true },
      });
      if (existing) {
        reply
          .status(200)
          .send(ok({ kind: 'message', messageId: existing.id } satisfies SlashExecuteResponse));
        return;
      }
    }

    // --- /roll ------------------------------------------------------------
    if (entry.name === 'roll') {
      const notation = body.args || '1d20';
      let rollResult;
      try {
        rollResult = evaluateDiceNotation(notation);
      } catch (err) {
        if (err instanceof DiceParseError) {
          throw new TavernError('INVALID_DICE_NOTATION', err.message, 400);
        }
        throw err;
      }
      const diceRollId = ulid();
      const messageId = ulid();
      const fullRow = await prisma.$transaction(async (tx) => {
        await tx.diceRoll.create({
          data: {
            id: diceRollId,
            serverId: result.serverId,
            channelId,
            userId: ctx.userId,
            notation: rollResult.notation,
            resultJson: rollResult,
            total: rollResult.total,
            visibility: 'public',
          },
        });
        await tx.message.create({
          data: {
            id: messageId,
            serverId: result.serverId,
            channelId,
            authorId: ctx.userId,
            type: 'dice_roll',
            content: rollResult.notation,
            diceRollId,
            nonce: body.nonce ?? null,
          },
        });
        return tx.message.findUniqueOrThrow({
          where: { id: messageId },
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
          },
        });
      });
      const dto = serializeMessage(fullRow as MessageRow, ctx.userId);
      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: result.serverId,
        channelId,
        data: dto,
      });
      reply
        .status(201)
        .send(ok({ kind: 'roll', diceRollId, messageId } satisfies SlashExecuteResponse));
      return;
    }

    // --- /me, /shrug, /tableflip, /unflip -------------------------------
    const textCommand = renderTextCommand(entry.name, body.args, ctx.userId);
    if (textCommand !== null) {
      const messageId = ulid();
      const fullRow = await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: messageId,
            serverId: result.serverId,
            channelId,
            authorId: ctx.userId,
            type: textCommand.type,
            content: sanitizeContent(textCommand.content),
            replyToMessageId: body.replyToMessageId ?? null,
            nonce: body.nonce ?? null,
          },
        });
        return tx.message.findUniqueOrThrow({
          where: { id: messageId },
          include: {
            attachments: { select: { id: true } },
            reactions: { select: { emoji: true, userId: true } },
            author: { select: { id: true, displayName: true, username: true } },
          },
        });
      });
      const dto = serializeMessage(fullRow as MessageRow, ctx.userId);
      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: result.serverId,
        channelId,
        data: dto,
      });
      reply
        .status(201)
        .send(ok({ kind: 'message', messageId } satisfies SlashExecuteResponse));
      return;
    }

    // --- Client-action commands hit here only if the client bypassed the
    // catalog; tell them politely to use the proper surface.
    if (entry.clientAction) {
      reply.status(200).send(
        ok({
          kind: 'noop',
          notice: `Use the ${entry.name} composer instead.`,
        } satisfies SlashExecuteResponse),
      );
      return;
    }

    // /pin and /save are wired in later phases (#4 and #5). For now,
    // return a soft notice so the autocomplete still surfaces them but
    // invoking them is non-fatal.
    reply.status(200).send(
      ok({
        kind: 'noop',
        notice: `/${entry.name} is not yet available — coming soon.`,
      } satisfies SlashExecuteResponse),
    );
  });
}

/**
 * Render the flavor-text commands. Returns null if `name` isn't a text
 * command (so the caller knows to fall through to other handlers).
 *
 * Note: `/me` prefixes its content with the actor's display name on render
 * client-side; we just store the raw action text and let the renderer
 * recognize the message type or a leading marker. To stay simple and
 * server-rendered-safe, we wrap the content in a *italic* convention
 * (`* waves hello *`) and rely on the client renderer for emphasis.
 */
function renderTextCommand(
  name: string,
  args: string,
  _userId: string,
): { type: 'default'; content: string } | null {
  const trimmed = args.trim();
  switch (name) {
    case 'me': {
      if (!trimmed) return null;
      return { type: 'default', content: `* ${trimmed} *` };
    }
    case 'shrug':
      return {
        type: 'default',
        content: trimmed ? `${trimmed} ¯\\_(ツ)_/¯` : `¯\\_(ツ)_/¯`,
      };
    case 'tableflip':
      return {
        type: 'default',
        content: trimmed
          ? `${trimmed} (╯°□°)╯︵ ┻━┻`
          : `(╯°□°)╯︵ ┻━┻`,
      };
    case 'unflip':
      return {
        type: 'default',
        content: trimmed ? `${trimmed} ┬─┬ ノ( ゜-゜ノ)` : `┬─┬ ノ( ゜-゜ノ)`,
      };
    default:
      return null;
  }
}
