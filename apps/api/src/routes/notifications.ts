import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import {
  idSchema,
  TavernError,
  updateUserNotificationPreferenceRequestSchema,
  updateServerMemberNotificationPreferenceRequestSchema,
  type UserNotificationPreference,
  type ServerMemberNotificationPreference,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { getServerPermissions } from '../services/permissions-service.js';

const USER_PREF_DEFAULTS: UserNotificationPreference = {
  soundEnabled: true,
  volume: 70,
  chatSoundsWhileInVoice: false,
  playOnlyWhenUnfocused: true,
  mentionsOverrideMute: true,
  snoozeUntil: null,
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursDays: [],
};

const SERVER_PREF_DEFAULTS = {
  muteAll: false,
  muteMessages: false,
  muteMentions: false,
};

async function getOrCreateUserPref(userId: string): Promise<UserNotificationPreference> {
  const row = await prisma.userNotificationPreference.upsert({
    where: { userId },
    create: { userId, ...USER_PREF_DEFAULTS },
    update: {},
  });
  return {
    soundEnabled: row.soundEnabled,
    volume: row.volume,
    chatSoundsWhileInVoice: row.chatSoundsWhileInVoice,
    playOnlyWhenUnfocused: row.playOnlyWhenUnfocused,
    mentionsOverrideMute: row.mentionsOverrideMute,
    snoozeUntil: row.snoozeUntil?.toISOString() ?? null,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    quietHoursDays: Array.isArray(row.quietHoursDays)
      ? (row.quietHoursDays as number[])
      : [],
  };
}

async function getOrCreateServerPref(
  serverId: string,
  userId: string,
): Promise<ServerMemberNotificationPreference> {
  const row = await prisma.serverMemberNotificationPreference.upsert({
    where: { serverId_userId: { serverId, userId } },
    create: { serverId, userId, ...SERVER_PREF_DEFAULTS },
    update: {},
  });
  return {
    serverId: row.serverId,
    muteAll: row.muteAll,
    muteMessages: row.muteMessages,
    muteMentions: row.muteMentions,
  };
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me/notification-preferences', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const prefs = await getOrCreateUserPref(ctx.userId);
      reply.send(ok(prefs));
    },
  });

  app.patch('/api/me/notification-preferences', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const body = updateUserNotificationPreferenceRequestSchema.parse(req.body);
      // Normalize snoozeUntil from ISO string to Date.
      const data: Record<string, unknown> = { ...body };
      if (body.snoozeUntil !== undefined) {
        data.snoozeUntil = body.snoozeUntil ? new Date(body.snoozeUntil) : null;
      }
      if (body.quietHoursDays !== undefined) {
        data.quietHoursDays = body.quietHoursDays as unknown[];
      }
      // Upsert with the requested fields; fall back to defaults on create.
      await prisma.userNotificationPreference.upsert({
        where: { userId: ctx.userId },
        create: {
          userId: ctx.userId,
          ...USER_PREF_DEFAULTS,
          ...(data as Record<string, never>),
          snoozeUntil: data.snoozeUntil as Date | null | undefined,
          quietHoursDays: (data.quietHoursDays ?? []) as object,
        },
        update: data as Record<string, never>,
      });
      const prefs = await getOrCreateUserPref(ctx.userId);
      reply.send(ok(prefs));
    },
  });

  app.get('/api/servers/:serverId/notification-preferences/me', {
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
      const perms = await getServerPermissions(serverId, ctx.userId);
      if (perms === 0n) throw TavernError.notFound('Server not found');
      const prefs = await getOrCreateServerPref(serverId, ctx.userId);
      reply.send(ok(prefs));
    },
  });

  app.patch('/api/servers/:serverId/notification-preferences/me', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const ctx = await app.requireUser(req, reply);
      const { serverId } = z.object({ serverId: idSchema }).parse(req.params);
      const perms = await getServerPermissions(serverId, ctx.userId);
      if (perms === 0n) throw TavernError.notFound('Server not found');
      const body = updateServerMemberNotificationPreferenceRequestSchema.parse(req.body);
      await prisma.serverMemberNotificationPreference.upsert({
        where: { serverId_userId: { serverId, userId: ctx.userId } },
        create: { serverId, userId: ctx.userId, ...SERVER_PREF_DEFAULTS, ...body },
        update: body,
      });
      const prefs = await getOrCreateServerPref(serverId, ctx.userId);
      reply.send(ok(prefs));
    },
  });
}
