/**
 * P4-3 — Mirror server/channel/member lifecycle service.
 *
 * Coverage matrix (per the task plan):
 *   1. createMirrorServer happy path — Server + synthetic @everyone Role +
 *      defaultRoleId + owner local user.
 *   2. createMirrorServer duplicate — second call with same serverId throws.
 *   3. upsertMirrorChannel insert — new row carries originInstanceId.
 *   4. upsertMirrorChannel update — second call with different name updates
 *      in place (same channelId).
 *   5. upsertMirrorChannel rejects voice / non-text/forum types.
 *   6. addMirrorMember happy path — RemoteUser/User mirror + ServerMember.
 *   7. addMirrorMember idempotent — same args twice returns same id.
 *   8. removeMirrorMember happy path — ServerMember row goes away.
 *   9. removeMirrorMember idempotent — missing row is a no-op.
 *  10. tearDownMirrorServerIfEmpty torn down — returns true; Server gone,
 *      Role gone, Channels gone.
 *  11. tearDownMirrorServerIfEmpty retained — one local member kept; nothing
 *      gets deleted.
 *  12. updateMirrorServer happy path — name + description updated.
 *  13. deleteMirrorChannel happy path — channel row removed.
 *  14. deleteMirrorChannel cross-server guard — rejects with the
 *      "belongs to server X, not Y" error and leaves the row intact.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient, type RemoteUser } from '@prisma/client';
import { PERMISSION_DEFAULT_EVERYONE, serializePermissions, ulid } from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';
import {
  FederationMirrorService,
  MirrorServerExistsError,
  type ResolveRemoteUserFn,
} from '../src/services/federation-mirror.js';

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

/**
 * Seed a peered RemoteInstance and the RemoteUser cache row for `localpart@host`.
 * Returns the RemoteUser row fresh from Postgres so callers can pass it into
 * the mirror service's resolveRemoteUser callback without worrying about
 * Buffer shape coming from in-memory construction.
 */
async function seedPeerAndRemoteUser(opts: {
  host: string;
  localpart: string;
  displayName?: string;
}): Promise<{ peerId: string; remoteUser: RemoteUser; remoteUserId: string }> {
  const peerId = ulid();
  await prisma.remoteInstance.create({
    data: {
      id: peerId,
      host: opts.host,
      instanceKey: Buffer.alloc(32, 2),
      status: 'peered',
      capabilities: ['messages', 'mirror'],
    },
  });
  const remoteUserId = `${opts.localpart}@${opts.host}`;
  await prisma.remoteUser.create({
    data: {
      id: ulid(),
      remoteInstanceId: peerId,
      remoteUserId,
      displayNameCache: opts.displayName ?? `${opts.localpart} on ${opts.host}`,
      avatarUrlCache: null,
      publicKey: Buffer.alloc(32, 11),
    },
  });
  const remoteUser = await prisma.remoteUser.findUniqueOrThrow({
    where: { remoteUserId },
  });
  return { peerId, remoteUser, remoteUserId };
}

/**
 * Build the FederationMirrorService with a resolver that hits the live
 * RemoteUser table. In production the resolver delegates to
 * FederationProfileService.fetchRemoteProfile on cache miss; the tests
 * pre-seed the cache and assert the service handles cache-hit cleanly.
 */
function buildService(): FederationMirrorService {
  const resolveRemoteUser: ResolveRemoteUserFn = async (remoteUserId, tx) => {
    const row = await tx.remoteUser.findUnique({ where: { remoteUserId } });
    if (!row) throw new Error(`test setup forgot to seed ${remoteUserId}`);
    return row;
  };
  return new FederationMirrorService({ resolveRemoteUser });
}

/**
 * Helper: make a local-user (passwordHash set, remoteInstanceId null). Used
 * to populate "still has a local member" tests. Returns the User id.
 */
async function seedLocalUser(prefix: string): Promise<string> {
  const id = ulid();
  const username = `${prefix}-${id.toLowerCase()}`;
  await prisma.user.create({
    data: {
      id,
      username,
      usernameLower: username,
      displayName: prefix,
      email: `${username}@local.test`,
      emailLower: `${username}@local.test`,
      passwordHash: '$argon2id$placeholder',
    },
  });
  return id;
}

/**
 * Run `fn` inside a Prisma transaction and return its output. Lets tests use
 * the service's tx-taking surface without each call site repeating the
 * boilerplate.
 */
async function runTx<T>(fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

describe.skipIf(!dockerOk)('FederationMirrorService', () => {
  describe('createMirrorServer', () => {
    it('creates Server + synthetic @everyone Role + owner local user', async () => {
      const { peerId, remoteUserId } = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'carol',
        displayName: 'Carol of the Peer',
      });
      const service = buildService();
      const serverId = ulid();

      const result = await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: peerId,
          ownerRemoteUserId: remoteUserId,
          name: 'Mirror Tavern',
          description: 'A mirror of Carol\'s tavern',
          iconUrl: null,
        }),
      );

      expect(result.serverId).toBe(serverId);
      expect(typeof result.everyoneRoleId).toBe('string');
      expect(typeof result.ownerLocalUserId).toBe('string');

      // Server row — originInstanceId set, defaultRoleId pointing at the
      // @everyone Role, federationEnabled true (mirrors implicitly federate).
      const server = await prisma.server.findUniqueOrThrow({
        where: { id: serverId },
      });
      expect(server.originInstanceId).toBe(peerId);
      expect(server.defaultRoleId).toBe(result.everyoneRoleId);
      expect(server.federationEnabled).toBe(true);
      expect(server.name).toBe('Mirror Tavern');
      expect(server.description).toBe('A mirror of Carol\'s tavern');

      // @everyone Role — isEveryone + DEFAULT_EVERYONE permissions bitset.
      const role = await prisma.role.findUniqueOrThrow({
        where: { id: result.everyoneRoleId },
      });
      expect(role.isEveryone).toBe(true);
      expect(role.name).toBe('@everyone');
      expect(role.position).toBe(0);
      expect(role.color).toBe(0);
      expect(role.serverId).toBe(serverId);
      expect(role.permissions.toString()).toBe(
        serializePermissions(PERMISSION_DEFAULT_EVERYONE),
      );

      // Owner — synthetic local User row with remoteUserId set.
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: result.ownerLocalUserId },
      });
      expect(owner.remoteUserId).toBe(remoteUserId);
      expect(owner.remoteInstanceId).toBe(peerId);
      expect(owner.passwordHash).toBeNull();

      // Owner is a ServerMember on the mirror.
      const member = await prisma.serverMember.findUnique({
        where: {
          serverId_userId: { serverId, userId: result.ownerLocalUserId },
        },
      });
      expect(member).not.toBeNull();
    });

    it('persists the home icon URL on the mirror Server row (#23)', async () => {
      const { peerId, remoteUserId } = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'iris',
      });
      const service = buildService();
      const serverId = ulid();
      const iconUrl = `https://${'icons'}.example/api/_attachments/main/${ulid()}.png`;

      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: peerId,
          ownerRemoteUserId: remoteUserId,
          name: 'Iconned Mirror',
          description: null,
          iconUrl,
        }),
      );

      const server = await prisma.server.findUniqueOrThrow({
        where: { id: serverId },
      });
      // Mirrors hold the home's public URL directly; no local attachment.
      expect(server.iconUrl).toBe(iconUrl);
      expect(server.iconAttachmentId).toBeNull();
    });

    it('throws MirrorServerExistsError when serverId is already a mirror', async () => {
      const { peerId, remoteUserId } = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'dave',
      });
      const service = buildService();
      const serverId = ulid();

      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: peerId,
          ownerRemoteUserId: remoteUserId,
          name: 'M',
          description: null,
          iconUrl: null,
        }),
      );

      await expect(
        runTx((tx) =>
          service.createMirrorServer({
            tx,
            serverId,
            originInstanceId: peerId,
            ownerRemoteUserId: remoteUserId,
            name: 'M2',
            description: null,
            iconUrl: null,
          }),
        ),
      ).rejects.toBeInstanceOf(MirrorServerExistsError);
    });
  });

  describe('upsertMirrorChannel', () => {
    let serverId: string;
    let peerId: string;

    beforeEach(async () => {
      const seeded = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'erin',
      });
      peerId = seeded.peerId;
      const service = buildService();
      serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: peerId,
          ownerRemoteUserId: seeded.remoteUserId,
          name: 'Channel Tests Mirror',
          description: null,
          iconUrl: null,
        }),
      );
    });

    it('inserts a new mirror channel with originInstanceId set', async () => {
      const service = buildService();
      const channelId = ulid();
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId,
          originInstanceId: peerId,
          channelId,
          name: 'general',
          type: 'text',
          topic: 'welcome',
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        }),
      );

      const channel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
      });
      expect(channel.originInstanceId).toBe(peerId);
      expect(channel.type).toBe('text');
      expect(channel.name).toBe('general');
      expect(channel.topic).toBe('welcome');
      expect(channel.position).toBe(0);
      expect(channel.federationMode).toBe('inherit');
      expect(channel.nsfw).toBe(false);
    });

    it('is idempotent — second call updates the user-visible fields', async () => {
      const service = buildService();
      const channelId = ulid();
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId,
          originInstanceId: peerId,
          channelId,
          name: 'old-name',
          type: 'text',
          topic: null,
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        }),
      );
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId,
          originInstanceId: peerId,
          channelId,
          name: 'new-name',
          type: 'text',
          topic: 'new topic',
          position: 3,
          federationMode: 'force_on',
          nsfw: true,
        }),
      );

      const channel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
      });
      expect(channel.name).toBe('new-name');
      expect(channel.topic).toBe('new topic');
      expect(channel.position).toBe(3);
      expect(channel.federationMode).toBe('force_on');
      expect(channel.nsfw).toBe(true);
      // originInstanceId + serverId + type must be unchanged.
      expect(channel.originInstanceId).toBe(peerId);
      expect(channel.serverId).toBe(serverId);
      expect(channel.type).toBe('text');

      const count = await prisma.channel.count({ where: { id: channelId } });
      expect(count).toBe(1);
    });

    it('rejects voice / non-text non-forum types', async () => {
      const service = buildService();
      await expect(
        runTx((tx) =>
          service.upsertMirrorChannel({
            tx,
            serverId,
            originInstanceId: peerId,
            channelId: ulid(),
            name: 'voicebox',
            // Cast: the type field is constrained to text|forum, but the
            // test exists to prove the runtime guard catches a misuse.
            type: 'voice' as unknown as 'text',
            topic: null,
            position: 0,
            federationMode: 'inherit',
            nsfw: false,
          }),
        ),
      ).rejects.toThrow(/text or forum/i);
    });
  });

  describe('addMirrorMember / removeMirrorMember', () => {
    let serverId: string;
    let peerId: string;
    let host: string;
    let memberRemoteUserId: string;

    beforeEach(async () => {
      host = `peer-${ulid().toLowerCase()}.example`;
      const owner = await seedPeerAndRemoteUser({
        host,
        localpart: 'frank',
      });
      peerId = owner.peerId;
      const service = buildService();
      serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Member Tests Mirror',
          description: null,
          iconUrl: null,
        }),
      );
      // Add another remote user from the same peer as the join candidate.
      const memberLocalpart = `gina-${ulid().slice(-6).toLowerCase()}`;
      memberRemoteUserId = `${memberLocalpart}@${host}`;
      await prisma.remoteUser.create({
        data: {
          id: ulid(),
          remoteInstanceId: peerId,
          remoteUserId: memberRemoteUserId,
          displayNameCache: 'Gina',
          avatarUrlCache: null,
          publicKey: Buffer.alloc(32, 17),
        },
      });
    });

    it('adds a member and returns the local user id', async () => {
      const service = buildService();
      const localUserId = await runTx((tx) =>
        service.addMirrorMember(tx, serverId, memberRemoteUserId, 'Gina'),
      );

      expect(typeof localUserId).toBe('string');
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: localUserId } },
      });
      expect(member).not.toBeNull();
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: localUserId },
      });
      expect(user.remoteUserId).toBe(memberRemoteUserId);
    });

    it('is idempotent on repeat add', async () => {
      const service = buildService();
      const first = await runTx((tx) =>
        service.addMirrorMember(tx, serverId, memberRemoteUserId, 'Gina'),
      );
      const second = await runTx((tx) =>
        service.addMirrorMember(tx, serverId, memberRemoteUserId, 'Gina'),
      );
      expect(second).toBe(first);

      const memberCount = await prisma.serverMember.count({
        where: { serverId, userId: first },
      });
      expect(memberCount).toBe(1);
    });

    it('removes a member', async () => {
      const service = buildService();
      const localUserId = await runTx((tx) =>
        service.addMirrorMember(tx, serverId, memberRemoteUserId, 'Gina'),
      );
      await runTx((tx) =>
        service.removeMirrorMember(tx, serverId, memberRemoteUserId),
      );
      const member = await prisma.serverMember.findUnique({
        where: { serverId_userId: { serverId, userId: localUserId } },
      });
      expect(member).toBeNull();
    });

    it('is idempotent when removing a non-member', async () => {
      const service = buildService();
      // Member was never added. Should not throw.
      await expect(
        runTx((tx) =>
          service.removeMirrorMember(tx, serverId, memberRemoteUserId),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('tearDownMirrorServerIfEmpty', () => {
    it('tears down a mirror with zero local members', async () => {
      // Seed peer + owner + mirror. The owner is remote (synthetic), so
      // the mirror has zero LOCAL members.
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'helga',
      });
      const service = buildService();
      const serverId = ulid();
      const { everyoneRoleId } = await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Teardown Mirror',
          description: null,
          iconUrl: null,
        }),
      );
      // Add a channel to prove cascade.
      const channelId = ulid();
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          channelId,
          name: 'general',
          type: 'text',
          topic: null,
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        }),
      );

      const tornDown = await runTx((tx) =>
        service.tearDownMirrorServerIfEmpty(tx, serverId),
      );
      expect(tornDown).toBe(true);

      expect(await prisma.server.findUnique({ where: { id: serverId } })).toBeNull();
      expect(await prisma.role.findUnique({ where: { id: everyoneRoleId } })).toBeNull();
      expect(await prisma.channel.findUnique({ where: { id: channelId } })).toBeNull();
    });

    it('retains a mirror with at least one local member', async () => {
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'isaac',
      });
      const service = buildService();
      const serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Retain Mirror',
          description: null,
          iconUrl: null,
        }),
      );

      // Attach a local user as a member of the mirror so teardown sees a
      // local participant and short-circuits.
      const localId = await seedLocalUser('localmember');
      await prisma.serverMember.create({
        data: { serverId, userId: localId },
      });

      const tornDown = await runTx((tx) =>
        service.tearDownMirrorServerIfEmpty(tx, serverId),
      );
      expect(tornDown).toBe(false);

      // Server + member still present.
      expect(await prisma.server.findUnique({ where: { id: serverId } })).not.toBeNull();
      expect(
        await prisma.serverMember.findUnique({
          where: { serverId_userId: { serverId, userId: localId } },
        }),
      ).not.toBeNull();
    });
  });

  describe('updateMirrorServer', () => {
    it('patches name + description in place', async () => {
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'jane',
      });
      const service = buildService();
      const serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Before',
          description: 'before-desc',
          iconUrl: null,
        }),
      );

      await runTx((tx) =>
        service.updateMirrorServer(tx, {
          serverId,
          name: 'After',
          description: 'after-desc',
        }),
      );

      const server = await prisma.server.findUniqueOrThrow({
        where: { id: serverId },
      });
      expect(server.name).toBe('After');
      expect(server.description).toBe('after-desc');
    });

    it('updates and clears the icon URL when provided (#23)', async () => {
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'liam',
      });
      const service = buildService();
      const serverId = ulid();
      const firstIcon = `https://icons.example/api/_attachments/main/${ulid()}.png`;
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Icon Update Mirror',
          description: null,
          iconUrl: firstIcon,
        }),
      );

      // Change the icon URL.
      const secondIcon = `https://icons.example/api/_attachments/main/${ulid()}.png`;
      await runTx((tx) =>
        service.updateMirrorServer(tx, { serverId, iconUrl: secondIcon }),
      );
      expect(
        (await prisma.server.findUniqueOrThrow({ where: { id: serverId } })).iconUrl,
      ).toBe(secondIcon);

      // Omitting iconUrl leaves it untouched (only name changes).
      await runTx((tx) =>
        service.updateMirrorServer(tx, { serverId, name: 'Renamed' }),
      );
      expect(
        (await prisma.server.findUniqueOrThrow({ where: { id: serverId } })).iconUrl,
      ).toBe(secondIcon);

      // Explicit null clears it.
      await runTx((tx) =>
        service.updateMirrorServer(tx, { serverId, iconUrl: null }),
      );
      expect(
        (await prisma.server.findUniqueOrThrow({ where: { id: serverId } })).iconUrl,
      ).toBeNull();
    });
  });

  describe('deleteMirrorChannel', () => {
    it('removes the channel row', async () => {
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'kim',
      });
      const service = buildService();
      const serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Channel Delete Mirror',
          description: null,
          iconUrl: null,
        }),
      );
      const channelId = ulid();
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          channelId,
          name: 'doomed',
          type: 'text',
          topic: null,
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        }),
      );

      await runTx((tx) =>
        service.deleteMirrorChannel(tx, serverId, channelId),
      );

      const channel = await prisma.channel.findUnique({
        where: { id: channelId },
      });
      expect(channel).toBeNull();
    });

    it('is a no-op when the channel does not exist', async () => {
      const owner = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'leo',
      });
      const service = buildService();
      const serverId = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId,
          originInstanceId: owner.peerId,
          ownerRemoteUserId: owner.remoteUserId,
          name: 'Noop Channel Mirror',
          description: null,
          iconUrl: null,
        }),
      );

      await expect(
        runTx((tx) => service.deleteMirrorChannel(tx, serverId, ulid())),
      ).resolves.toBeUndefined();
    });

    it('rejects a cross-server delete and preserves the channel row', async () => {
      // Defence-in-depth check: the cross-server guard in
      // deleteMirrorChannel refuses to delete a channel whose serverId
      // doesn't match the caller-supplied serverId. Without this test, a
      // future refactor could silently drop the guard and let a buggy
      // (or malicious) peer instruct us to delete a channel from a
      // different mirror.
      const ownerA = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'mira',
      });
      const ownerB = await seedPeerAndRemoteUser({
        host: `peer-${ulid().toLowerCase()}.example`,
        localpart: 'nico',
      });
      const service = buildService();
      const serverA = ulid();
      const serverB = ulid();
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId: serverA,
          originInstanceId: ownerA.peerId,
          ownerRemoteUserId: ownerA.remoteUserId,
          name: 'Cross-Server Mirror A',
          description: null,
          iconUrl: null,
        }),
      );
      await runTx((tx) =>
        service.createMirrorServer({
          tx,
          serverId: serverB,
          originInstanceId: ownerB.peerId,
          ownerRemoteUserId: ownerB.remoteUserId,
          name: 'Cross-Server Mirror B',
          description: null,
          iconUrl: null,
        }),
      );

      // channelA1 lives on serverA.
      const channelA1 = ulid();
      await runTx((tx) =>
        service.upsertMirrorChannel({
          tx,
          serverId: serverA,
          originInstanceId: ownerA.peerId,
          channelId: channelA1,
          name: 'a-general',
          type: 'text',
          topic: null,
          position: 0,
          federationMode: 'inherit',
          nsfw: false,
        }),
      );

      // Calling deleteMirrorChannel with serverB's id should be refused.
      await expect(
        runTx((tx) => service.deleteMirrorChannel(tx, serverB, channelA1)),
      ).rejects.toThrow(
        `channel ${channelA1} belongs to server ${serverA}, not ${serverB}`,
      );

      // The channel must still exist after the rejected call.
      const channel = await prisma.channel.findUnique({
        where: { id: channelA1 },
      });
      expect(channel).not.toBeNull();
      expect(channel?.serverId).toBe(serverA);
    });
  });
});
