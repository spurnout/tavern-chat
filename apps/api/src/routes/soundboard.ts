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

const createClipSchema = z.object({
  name: z.string().min(1).max(60),
  attachmentId: idSchema,
  color: z.string().max(7).optional(),
  /** Wave 3 #19 — mark this clip as a looping ambient pad. */
  isAmbient: z.boolean().optional(),
});

const cueBodySchema = z.object({
  clipId: idSchema,
  /** Loops the clip on the receiver. Ambient clips default to true here. */
  loop: z.boolean().default(false),
});

const stopBodySchema = z.object({
  clipId: idSchema,
});

export async function registerSoundboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/servers/:id/soundboard', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    await requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL);
    const clips = await prisma.soundboardClip.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    });
    reply.send(
      ok(
        clips.map((c) => ({
          id: c.id,
          serverId: c.serverId,
          name: c.name,
          attachmentId: c.attachmentId,
          color: c.color,
          position: c.position,
          isAmbient: c.isAmbient,
          addedBy: c.addedBy,
          createdAt: c.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.post('/api/servers/:id/soundboard', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: serverId } = z.object({ id: idSchema }).parse(req.params);
    const body = createClipSchema.parse(req.body);
    // MANAGE_EMOJIS is a good proxy permission for "tavern audio assets".
    await requireServerPermission(serverId, ctx.userId, Permission.MANAGE_EMOJIS);

    // Validate attachment ownership + audio kind.
    const att = await prisma.attachment.findUnique({
      where: { id: body.attachmentId },
      select: { id: true, kind: true, uploaderId: true, status: true },
    });
    if (!att) throw TavernError.notFound('Attachment not found');
    if (att.kind !== 'audio' && att.kind !== 'voice_message') {
      throw TavernError.validation('Soundboard clips must be audio attachments');
    }
    if (att.status !== 'ready') {
      throw new TavernError('UPLOAD_NOT_READY', 'Attachment not ready', 400);
    }

    const maxPos = await prisma.soundboardClip.aggregate({
      where: { serverId },
      _max: { position: true },
    });
    const clip = await prisma.soundboardClip.create({
      data: {
        id: ulid(),
        serverId,
        name: body.name,
        attachmentId: body.attachmentId,
        color: body.color ?? null,
        position: (maxPos._max.position ?? -1) + 1,
        isAmbient: body.isAmbient ?? false,
        addedBy: ctx.userId,
      },
    });
    reply.status(201).send(
      ok({
        id: clip.id,
        serverId: clip.serverId,
        name: clip.name,
        attachmentId: clip.attachmentId,
        color: clip.color,
        position: clip.position,
        isAmbient: clip.isAmbient,
        addedBy: clip.addedBy,
        createdAt: clip.createdAt.toISOString(),
      }),
    );
  });

  /**
   * Toggle a clip's ambient flag. Keeps the create surface narrow while
   * giving operators a way to relabel existing clips without re-uploading.
   */
  app.patch('/api/soundboard/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(60).optional(),
        color: z.string().max(7).nullable().optional(),
        isAmbient: z.boolean().optional(),
      })
      .parse(req.body);
    const clip = await prisma.soundboardClip.findUnique({ where: { id } });
    if (!clip) throw TavernError.notFound('Clip not found');
    await requireServerPermission(clip.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    const next = await prisma.soundboardClip.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.isAmbient !== undefined ? { isAmbient: body.isAmbient } : {}),
      },
    });
    reply.send(
      ok({
        id: next.id,
        serverId: next.serverId,
        name: next.name,
        attachmentId: next.attachmentId,
        color: next.color,
        position: next.position,
        isAmbient: next.isAmbient,
        addedBy: next.addedBy,
        createdAt: next.createdAt.toISOString(),
      }),
    );
  });

  app.delete('/api/soundboard/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const clip = await prisma.soundboardClip.findUnique({ where: { id } });
    if (!clip) throw TavernError.notFound('Clip not found');
    await requireServerPermission(clip.serverId, ctx.userId, Permission.MANAGE_EMOJIS);
    await prisma.soundboardClip.delete({ where: { id } });
    reply.send(ok({ id }));
  });

  // Trigger a clip into a voice channel.
  app.post('/api/voice/:channelId/soundboard', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    const body = cueBodySchema.parse(req.body);
    // SPEAK_VOICE is the right gate — anyone who can speak in the channel
    // can cue a clip. Operators tighten this with channel overwrites.
    await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);

    const clip = await prisma.soundboardClip.findUnique({
      where: { id: body.clipId },
      include: { server: { select: { id: true } } },
    });
    if (!clip) throw TavernError.notFound('Clip not found');

    gatewayBroker.publish({
      type: 'SOUNDBOARD_CUE',
      channelId,
      data: {
        clipId: clip.id,
        attachmentId: clip.attachmentId,
        name: clip.name,
        // Ambient clips default to looping unless the caller explicitly
        // overrides — saves the UI from having to remember to set loop=true.
        loop: body.loop || clip.isAmbient,
        triggeredBy: ctx.userId,
      },
    });
    reply.send(ok({ ok: true }));
  });

  /**
   * Wave 3 #19 — stop a previously cued ambient loop. Listeners match by
   * clipId and pause whichever HTMLAudioElement they spun up for it.
   */
  app.post('/api/voice/:channelId/soundboard/stop', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    const body = stopBodySchema.parse(req.body);
    await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
    gatewayBroker.publish({
      type: 'SOUNDBOARD_STOP',
      channelId,
      data: { clipId: body.clipId, triggeredBy: ctx.userId },
    });
    reply.send(ok({ ok: true }));
  });
}
