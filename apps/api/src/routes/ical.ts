import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { APP_NAME, idSchema, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';

/**
 * Wave 2 #20 — iCal subscription feed for campaign sessions.
 *
 * Tokens are minted per-(user, kind). Feed URLs are opaque — the
 * `secretToken` is the auth. Subscribers see only campaigns they're a
 * member of (or all campaigns on a server they belong to for the GM).
 */

const mintBodySchema = z.object({
  kind: z.enum(['all', 'campaign']),
  campaignId: idSchema.optional(),
});

function escapeIcs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function formatIcsDate(d: Date): string {
  // YYYYMMDDTHHmmssZ
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldLines(lines: string[]): string {
  // RFC 5545 fold lines longer than 75 octets.
  const folded: string[] = [];
  for (const line of lines) {
    if (line.length <= 75) {
      folded.push(line);
      continue;
    }
    let remaining = line;
    folded.push(remaining.slice(0, 75));
    remaining = remaining.slice(75);
    while (remaining.length > 74) {
      folded.push(' ' + remaining.slice(0, 74));
      remaining = remaining.slice(74);
    }
    if (remaining.length > 0) folded.push(' ' + remaining);
  }
  return folded.join('\r\n');
}

export async function registerIcalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/ical-tokens', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const rows = await prisma.icalToken.findMany({
      where: { userId: ctx.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    reply.send(
      ok(
        rows.map((t) => ({
          id: t.id,
          kind: t.kind,
          campaignId: t.campaignId,
          secretToken: t.secretToken,
          createdAt: t.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/me/ical-tokens', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = mintBodySchema.parse(req.body);
    if (body.kind === 'campaign' && !body.campaignId) {
      throw TavernError.validation('campaignId required for kind=campaign');
    }
    if (body.kind === 'campaign' && body.campaignId) {
      const member = await prisma.campaignMember.findUnique({
        where: { campaignId_userId: { campaignId: body.campaignId, userId: ctx.userId } },
      });
      const campaign = await prisma.campaign.findUnique({
        where: { id: body.campaignId },
        select: { gmUserId: true },
      });
      if (!member && campaign?.gmUserId !== ctx.userId) {
        throw TavernError.forbidden();
      }
    }
    const secretToken = crypto.randomBytes(24).toString('base64url');
    const row = await prisma.icalToken.create({
      data: {
        id: ulid(),
        userId: ctx.userId,
        kind: body.kind,
        campaignId: body.campaignId ?? null,
        secretToken,
      },
    });
    reply.status(201).send(
      ok({
        id: row.id,
        kind: row.kind,
        campaignId: row.campaignId,
        secretToken,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  });

  app.delete('/api/me/ical-tokens/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.icalToken.findUnique({ where: { id } });
    if (!row || row.userId !== ctx.userId) throw TavernError.notFound('Token not found');
    await prisma.icalToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    reply.send(ok({ id }));
  });

  // Public ICS endpoint — no session, secret is the auth.
  app.get('/api/calendar/:kind/feed.ics', async (req, reply) => {
    const params = z
      .object({ kind: z.enum(['all', 'campaign']) })
      .parse(req.params);
    const query = z
      .object({ token: z.string().min(8), campaignId: idSchema.optional() })
      .parse(req.query);
    const token = await prisma.icalToken.findUnique({
      where: { secretToken: query.token },
    });
    if (!token || token.revokedAt || token.kind !== params.kind) {
      throw TavernError.notFound('Token not found');
    }

    const userId = token.userId;
    let campaignIds: string[] = [];
    if (token.kind === 'campaign') {
      if (!token.campaignId) throw TavernError.notFound();
      campaignIds = [token.campaignId];
    } else {
      const memberships = await prisma.campaignMember.findMany({
        where: { userId },
        select: { campaignId: true },
      });
      const asGm = await prisma.campaign.findMany({
        where: { gmUserId: userId },
        select: { id: true },
      });
      campaignIds = [...new Set([...memberships.map((m) => m.campaignId), ...asGm.map((c) => c.id)])];
    }

    const sessions = await prisma.campaignSession.findMany({
      where: { campaignId: { in: campaignIds }, scheduledStart: { not: null } },
      include: { campaign: { select: { name: true } } },
      orderBy: { scheduledStart: 'asc' },
    });

    const lines: string[] = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push(`PRODID:-//${APP_NAME}//Tavern Sessions//EN`);
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    for (const s of sessions) {
      if (!s.scheduledStart) continue;
      const start = s.scheduledStart;
      const end = s.scheduledEnd ?? new Date(start.getTime() + 3 * 60 * 60 * 1000);
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${s.id}@tavern`);
      lines.push(`DTSTAMP:${formatIcsDate(new Date())}`);
      lines.push(`DTSTART:${formatIcsDate(start)}`);
      lines.push(`DTEND:${formatIcsDate(end)}`);
      lines.push(`SUMMARY:${escapeIcs(`${s.campaign.name}: ${s.title}`)}`);
      if (s.description) {
        lines.push(`DESCRIPTION:${escapeIcs(s.description)}`);
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.send(foldLines(lines) + '\r\n');
  });
}
