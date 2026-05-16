import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import {
  requireChannelPermission,
  requireServerPermission,
} from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

const cardSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  body: z.string().max(2000).optional(),
});

const createDeckSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  cards: z.array(cardSchema).min(1).max(500),
});

const updateDeckSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  cards: z.array(cardSchema).min(1).max(500).optional(),
});

const drawBodySchema = z.object({
  /** Optional channel — when set, post a system message announcing the draw. */
  channelId: idSchema.optional(),
  /** When true, the draw is private — only the caller sees it. */
  isPrivate: z.boolean().optional(),
});

/**
 * Wave 3 #20 — custom card decks per server.
 *
 * A deck is a named, ordered list of cards stored as JSON. The "draw"
 * endpoint pulls one card uniformly at random — no per-session shelf yet
 * (so the same card can repeat across draws), which matches the way
 * most table-side decks work in practice (you reshuffle anyway).
 *
 * The draw result is always returned to the caller; with `channelId`, a
 * system message also lands in chat so the whole table sees it. A
 * `DECK_DRAW` gateway event fans the draw out to interested clients.
 */
export async function registerDeckRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/decks', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const rows = await prisma.cardDeck.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(ok(rows.map(serialize)));
  });

  app.post('/api/servers/:id/decks', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createDeckSchema.parse(req.body);
    // Use the same MANAGE_EMOJIS gate the soundboard uses — "tavern
    // tabletop assets" — so operators don't need to mint a new permission
    // bit for what is a fairly niche feature.
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    if (!cardIdsUnique(body.cards)) {
      throw TavernError.validation('Card ids must be unique within a deck');
    }
    const row = await prisma.cardDeck.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        description: body.description ?? null,
        cardsJson: body.cards,
        createdBy: ctx.userId,
      },
    });
    reply.status(201).send(ok(serialize(row)));
  });

  app.patch('/api/decks/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateDeckSchema.parse(req.body);
    const deck = await prisma.cardDeck.findUnique({ where: { id } });
    if (!deck) throw TavernError.notFound('Deck not found');
    await requireServerPermission(deck.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    if (body.cards && !cardIdsUnique(body.cards)) {
      throw TavernError.validation('Card ids must be unique within a deck');
    }
    const updated = await prisma.cardDeck.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.cards !== undefined ? { cardsJson: body.cards } : {}),
      },
    });
    reply.send(ok(serialize(updated)));
  });

  app.delete('/api/decks/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const deck = await prisma.cardDeck.findUnique({ where: { id } });
    if (!deck) throw TavernError.notFound('Deck not found');
    await requireServerPermission(deck.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    await prisma.cardDeck.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  app.post('/api/decks/:id/draw', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = drawBodySchema.parse(req.body ?? {});
    const deck = await prisma.cardDeck.findUnique({ where: { id } });
    if (!deck) throw TavernError.notFound('Deck not found');
    // Anyone with VIEW_CHANNEL on the server can draw — drawing is read-shaped.
    await requireServerPermission(deck.serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const cards = parseCards(deck.cardsJson);
    if (cards.length === 0) {
      throw TavernError.validation('Deck has no cards');
    }
    const drawn = cards[Math.floor(Math.random() * cards.length)];
    if (!drawn) throw TavernError.validation('Deck has no cards');
    const result = {
      deckId: deck.id,
      deckName: deck.name,
      card: drawn,
      drawnBy: ctx.userId,
      drawnAt: new Date().toISOString(),
      isPrivate: body.isPrivate ?? false,
    };
    if (body.channelId && !result.isPrivate) {
      // Validate channel access + post a system message with the result.
      await requireChannelPermission(body.channelId, ctx.userId, Permission.SEND_MESSAGES);
      const message = await prisma.message.create({
        data: {
          id: ulid(),
          channelId: body.channelId,
          serverId: deck.serverId,
          authorId: ctx.userId,
          type: 'system',
          content: `🎴 Drew **${drawn.label}** from *${deck.name}*${
            drawn.body ? `\n\n${drawn.body}` : ''
          }`,
        },
      });
      gatewayBroker.publish({
        type: 'MESSAGE_CREATE',
        serverId: deck.serverId,
        channelId: body.channelId,
        data: {
          id: message.id,
          channelId: message.channelId,
          serverId: message.serverId,
          authorId: message.authorId,
          type: message.type,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
        },
      });
    }
    reply.send(ok(result));
  });
}

interface CardLike {
  id: string;
  label: string;
  body?: string;
}

function cardIdsUnique(cards: CardLike[]): boolean {
  const seen = new Set<string>();
  for (const c of cards) {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
  }
  return true;
}

function parseCards(json: unknown): CardLike[] {
  if (!Array.isArray(json)) return [];
  const out: CardLike[] = [];
  for (const c of json) {
    if (
      c &&
      typeof c === 'object' &&
      typeof (c as { id?: unknown }).id === 'string' &&
      typeof (c as { label?: unknown }).label === 'string'
    ) {
      const card = c as { id: string; label: string; body?: unknown };
      out.push({
        id: card.id,
        label: card.label,
        ...(typeof card.body === 'string' ? { body: card.body } : {}),
      });
    }
  }
  return out;
}

function serialize(row: {
  id: string;
  serverId: string;
  name: string;
  description: string | null;
  cardsJson: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    description: row.description,
    cards: parseCards(row.cardsJson),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
