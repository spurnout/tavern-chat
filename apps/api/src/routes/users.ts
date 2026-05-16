/**
 * User-profile routes — power the Discord-style member profile card.
 *
 * Member rows in `GET /api/servers/:id/members` stay lean (just the bits the
 * sidebar needs to render). The popover lazily fetches the rich profile via
 * `GET /api/users/:userId/profile` on first open and caches it client-side.
 */

import type { FastifyInstance } from 'fastify';
import { Prisma, prisma } from '@tavern/db';
import { z } from 'zod';
import {
  idSchema,
  TavernError,
  updateProfileRequestSchema,
  type MutualServer,
  type UserProfile,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { serializeUserProfile } from '../lib/serializers.js';
import { usersShareServer } from '../services/dm-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

/**
 * Servers both viewer and target are members of. Used to populate the
 * "Also in N of your taverns" section on the profile card. Empty when the
 * two are the same user.
 */
async function findMutualServers(
  viewerId: string,
  targetId: string,
): Promise<MutualServer[]> {
  if (viewerId === targetId) return [];
  const rows = await prisma.server.findMany({
    where: {
      members: { some: { userId: viewerId } },
      AND: { members: { some: { userId: targetId } } },
    },
    select: { id: true, name: true, iconAttachmentId: true },
    orderBy: { name: 'asc' },
  });
  return rows;
}

const profileSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarAttachmentId: true,
  bio: true,
  presence: true,
  pronouns: true,
  accentColor: true,
  timezone: true,
  customStatus: true,
  customStatusExpiresAt: true,
  socialLinks: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

function isValidTimezone(tz: string): boolean {
  // `Intl.supportedValuesOf` is Node 18+ and present in modern browsers.
  // Fall back to a try/catch DateTimeFormat construction if the function
  // isn't available so this never hard-crashes on an older runtime.
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === 'function') {
    return intl.supportedValuesOf('timeZone').includes(tz);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // Get a user's profile. Self-fetch is always allowed; otherwise the viewer
  // and target must share a server (same gate as DMs).
  app.get('/api/users/:userId/profile', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { userId } = z.object({ userId: idSchema }).parse(req.params);

    if (userId !== ctx.userId) {
      const share = await usersShareServer(ctx.userId, userId);
      // Mirror DM's "no shared server" handling: return 404 rather than 403
      // so we don't disclose whether the userId exists.
      if (!share) throw TavernError.notFound('User not found');
    }

    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });
    if (!row) throw TavernError.notFound('User not found');
    const mutualServers = await findMutualServers(ctx.userId, userId);
    reply.send(ok(serializeUserProfile(row, mutualServers)));
  });

  // Edit your own profile. Fields are all optional; only sent fields are
  // changed (PATCH semantics). On success we broadcast a partial MEMBER_UPDATE
  // to every server you're a member of so other clients refresh open cards.
  app.patch('/api/users/me/profile', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const body = updateProfileRequestSchema.parse(req.body);

    if (body.timezone != null && !isValidTimezone(body.timezone)) {
      throw TavernError.validation('Unknown IANA timezone');
    }

    const data: Prisma.UserUpdateInput = {};
    if (body.displayName !== undefined) data.displayName = body.displayName;
    if (body.bio !== undefined) data.bio = body.bio;
    if (body.avatarAttachmentId !== undefined) data.avatarAttachmentId = body.avatarAttachmentId;
    if (body.pronouns !== undefined) data.pronouns = body.pronouns;
    if (body.accentColor !== undefined) data.accentColor = body.accentColor;
    if (body.timezone !== undefined) data.timezone = body.timezone;
    if (body.customStatus !== undefined) data.customStatus = body.customStatus;
    if (body.customStatusExpiresAt !== undefined) {
      data.customStatusExpiresAt = body.customStatusExpiresAt
        ? new Date(body.customStatusExpiresAt)
        : null;
    }
    if (body.socialLinks !== undefined) {
      data.socialLinks = body.socialLinks as unknown as Prisma.InputJsonValue;
    }

    const updated = await prisma.user.update({
      where: { id: ctx.userId },
      data,
      select: profileSelect,
    });

    const profile: UserProfile = serializeUserProfile(updated);

    // Broadcast a partial MEMBER_UPDATE per shared server so open profile
    // cards on other clients pick up the change. Only forwards the
    // user-facing fields that may have changed (no email / lockout state).
    const memberships = await prisma.serverMember.findMany({
      where: { userId: ctx.userId },
      select: { serverId: true },
    });
    for (const { serverId } of memberships) {
      gatewayBroker.publish({
        type: 'MEMBER_UPDATE',
        serverId,
        data: {
          serverId,
          userId: ctx.userId,
          user: {
            id: profile.id,
            displayName: profile.displayName,
            avatarAttachmentId: profile.avatarAttachmentId,
            bio: profile.bio,
            pronouns: profile.pronouns,
            accentColor: profile.accentColor,
            timezone: profile.timezone,
            customStatus: profile.customStatus,
            customStatusExpiresAt: profile.customStatusExpiresAt,
            socialLinks: profile.socialLinks,
          },
        },
      });
    }

    reply.send(ok(profile));
  });
}
