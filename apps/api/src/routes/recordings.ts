import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import { idSchema, Permission, TavernError, ulid } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireChannelPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Wave 3 #32 — session recordings.
 *
 * Recording itself happens entirely in the browser (MediaRecorder against
 * the LiveKit-mixed stream); the server is the source of truth for the
 * consent flow plus a persistence linker (Attachment id → channel +
 * window). Consent is signalled live via gateway events — no consent rows
 * persisted — so a refresh resets the flow.
 *
 * Flow:
 *   1. Host POSTs /api/voice/:channelId/recording/propose → gateway fans
 *      RECORDING_CONSENT_REQUEST to every participant.
 *   2. Each participant POSTs /consent { consent: true|false } → gateway
 *      fans RECORDING_CONSENT_UPDATE. The host's UI tracks who's pending.
 *   3. When all participants have consented, the host's UI starts the
 *      MediaRecorder locally and POSTs /start → gateway broadcasts
 *      RECORDING_STARTED so everyone's UI shows a red dot.
 *   4. On stop, the host's UI uploads the .webm via the existing
 *      attachment pipeline, then POSTs /complete { attachmentId,
 *      startedAt, endedAt } which writes the SessionRecording row +
 *      broadcasts RECORDING_STOPPED.
 */
export async function registerRecordingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/voice/:channelId/recording/propose', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
      gatewayBroker.publish({
        type: 'RECORDING_CONSENT_REQUEST',
        serverId: result.serverId,
        channelId,
        data: { channelId, proposerUserId: ctx.userId, proposedAt: Date.now() },
      });
      reply.send(ok({ ok: true }));
    },
  });

  app.post('/api/voice/:channelId/recording/consent', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    const body = z.object({ consent: z.boolean() }).parse(req.body);
    const result = await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
    gatewayBroker.publish({
      type: 'RECORDING_CONSENT_UPDATE',
      serverId: result.serverId,
      channelId,
      data: { channelId, userId: ctx.userId, consent: body.consent, at: Date.now() },
    });
    reply.send(ok({ ok: true }));
  });

  app.post('/api/voice/:channelId/recording/start', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
      gatewayBroker.publish({
        type: 'RECORDING_STARTED',
        serverId: result.serverId,
        channelId,
        data: { channelId, recorderUserId: ctx.userId, startedAt: Date.now() },
      });
      reply.send(ok({ ok: true }));
    },
  });

  app.post('/api/voice/:channelId/recording/complete', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
      const body = z
        .object({
          attachmentId: idSchema,
          startedAt: z.string().datetime(),
          endedAt: z.string().datetime(),
        })
        .parse(req.body);
      const result = await requireChannelPermission(channelId, ctx.userId, Permission.SPEAK_VOICE);
      // Validate that the attachment belongs to the caller — recordings
      // can't be hijacked onto someone else's upload.
      const att = await prisma.attachment.findUnique({
        where: { id: body.attachmentId },
        select: { id: true, uploaderId: true, kind: true, status: true },
      });
      if (!att || att.uploaderId !== ctx.userId) {
        throw TavernError.notFound('Attachment not found');
      }
      if (att.kind !== 'audio' && att.kind !== 'voice_message' && att.kind !== 'video') {
        throw TavernError.validation('Recording attachment must be audio or video');
      }
      const row = await prisma.sessionRecording.create({
        data: {
          id: ulid(),
          channelId,
          attachmentId: body.attachmentId,
          recordedBy: ctx.userId,
          startedAt: new Date(body.startedAt),
          endedAt: new Date(body.endedAt),
        },
      });
      gatewayBroker.publish({
        type: 'RECORDING_STOPPED',
        serverId: result.serverId,
        channelId,
        data: { channelId, recordingId: row.id, endedAt: row.endedAt.toISOString() },
      });
      reply.status(201).send(
        ok({
          id: row.id,
          channelId: row.channelId,
          attachmentId: row.attachmentId,
          recordedBy: row.recordedBy,
          startedAt: row.startedAt.toISOString(),
          endedAt: row.endedAt.toISOString(),
        }),
      );
    },
  });

  app.get('/api/voice/:channelId/recordings', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { channelId } = z.object({ channelId: idSchema }).parse(req.params);
    await requireChannelPermission(channelId, ctx.userId, Permission.VIEW_CHANNEL);
    const rows = await prisma.sessionRecording.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    reply.send(
      ok(
        rows.map((r) => ({
          id: r.id,
          channelId: r.channelId,
          attachmentId: r.attachmentId,
          recordedBy: r.recordedBy,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.endedAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      ),
    );
  });

  app.delete('/api/recordings/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const row = await prisma.sessionRecording.findUnique({ where: { id } });
    if (!row) throw TavernError.notFound('Recording not found');
    if (row.recordedBy !== ctx.userId) {
      await requireChannelPermission(row.channelId, ctx.userId, Permission.MANAGE_CHANNELS);
    }
    await prisma.sessionRecording.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
