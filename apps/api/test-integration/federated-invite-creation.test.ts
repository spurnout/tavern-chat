/**
 * P4-4 — federated invite creation through POST /api/invites.
 *
 * Phase 4 lets a Tavern admin scope an invite to peers (any peer, a specific
 * peered instance, or a specific peered user). The route runs a tight
 * validation block AFTER the existing local-invite checks so the legacy
 * code path is untouched when callers don't set `remoteScope`.
 *
 * Coverage matrix:
 *   - Happy paths for each of the three remoteScope values.
 *   - Each documented validation failure (8 total) returns 400 with a clear
 *     message and the corresponding row is NOT created.
 *   - Non-admin caller (no CREATE_INVITES) → 403, even with valid federated
 *     fields. Same gate the local invite-create path uses.
 *   - Local invite creation (no remoteScope set) still works and produces
 *     nullable federated fields — regression coverage for the most common
 *     path.
 *
 * Auth + bootstrap match server-federation-toggle.test.ts (P3-10) and
 * channel-federation-mode.test.ts (P3-11): a PAT minted directly into the
 * `apiToken` table, plus an `@everyone` role on every server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import {
  PERMISSION_DEFAULT_EVERYONE,
  Permission,
  serializePermissions,
  ulid,
} from '@tavern/shared';
import {
  isDockerAvailable,
  startPostgres,
  stopPostgres,
  type IntegrationContext,
} from './setup.js';

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

interface Fixture {
  ownerId: string;
  memberId: string;
  serverId: string;
  /**
   * Server with federationEnabled=true. The route's gate (#2) requires this.
   */
  fedServerId: string;
  /**
   * Server with federationEnabled=false. Used to exercise gate #2.
   */
  localServerId: string;
  peeredHost: string;
  peeredHostB: string;
  pendingHost: string;
}

async function makeUser(id: string, slug: string): Promise<void> {
  await prisma.user.create({
    data: {
      id,
      username: slug,
      usernameLower: slug,
      displayName: slug,
      email: `${slug}@example.test`,
      emailLower: `${slug}@example.test`,
      passwordHash: 'x',
    },
  });
}

async function makeServer(args: {
  serverId: string;
  ownerId: string;
  memberId: string;
  name: string;
  federationEnabled: boolean;
}): Promise<void> {
  const { serverId, ownerId, memberId, name, federationEnabled } = args;
  await prisma.server.create({
    data: { id: serverId, ownerUserId: ownerId, name, federationEnabled },
  });
  const everyoneId = ulid();
  await prisma.role.create({
    data: {
      id: everyoneId,
      serverId,
      name: '@everyone',
      isEveryone: true,
      permissions: new Prisma.Decimal(serializePermissions(PERMISSION_DEFAULT_EVERYONE)),
    },
  });
  await prisma.server.update({ where: { id: serverId }, data: { defaultRoleId: everyoneId } });
  // Owner is implicit via Server.ownerUserId (the permission resolver treats
  // them as an admin), but membership rows still need to exist so the gateway
  // and member-listing endpoints behave correctly.
  await prisma.serverMember.create({ data: { serverId, userId: ownerId } });
  await prisma.serverMember.create({ data: { serverId, userId: memberId } });
}

async function makeFixture(): Promise<Fixture> {
  const ownerId = ulid();
  const memberId = ulid();
  const fedServerId = ulid();
  const localServerId = ulid();
  const peeredHost = `peer-${ulid().toLowerCase()}.example`;
  const peeredHostB = `peer-${ulid().toLowerCase()}.example`;
  const pendingHost = `pending-${ulid().toLowerCase()}.example`;

  await makeUser(ownerId, `owner-${ownerId.slice(-6).toLowerCase()}`);
  await makeUser(memberId, `member-${memberId.slice(-6).toLowerCase()}`);

  await makeServer({
    serverId: fedServerId,
    ownerId,
    memberId,
    name: 'Federated Tavern',
    federationEnabled: true,
  });
  await makeServer({
    serverId: localServerId,
    ownerId,
    memberId,
    name: 'Local Tavern',
    federationEnabled: false,
  });

  // Two peered instances + one pending (NOT peered) instance, used to verify
  // the route only accepts hosts in status='peered'.
  await prisma.remoteInstance.create({
    data: {
      id: ulid(),
      host: peeredHost,
      instanceKey: Buffer.alloc(32, 1),
      status: 'peered',
      capabilities: ['messages', 'invites'],
    },
  });
  await prisma.remoteInstance.create({
    data: {
      id: ulid(),
      host: peeredHostB,
      instanceKey: Buffer.alloc(32, 2),
      status: 'peered',
      capabilities: ['messages', 'invites'],
    },
  });
  await prisma.remoteInstance.create({
    data: {
      id: ulid(),
      host: pendingHost,
      instanceKey: Buffer.alloc(32, 3),
      status: 'pending_outbound',
      capabilities: [],
    },
  });

  return {
    ownerId,
    memberId,
    serverId: fedServerId,
    fedServerId,
    localServerId,
    peeredHost,
    peeredHostB,
    pendingHost,
  };
}

async function mintToken(userId: string): Promise<string> {
  const raw = `tvn_pat_${randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.apiToken.create({
    data: { id: ulid(), userId, label: 'test', tokenHash: hash },
  });
  return raw;
}

function envFor(dbUrl: string): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: dbUrl,
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    FEDERATION_ENABLED: 'true',
    TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_BASE_URL: 'https://self.example',
  } as NodeJS.ProcessEnv;
}

type InviteResponse = {
  data: {
    id: string;
    code: string;
    scope: string;
    serverId: string | null;
    remoteScope: string | null;
    remoteInstanceHost: string | null;
    remoteUserId: string | null;
  };
};

type ErrorResponse = { error: { code: string; message: string } };

describe.skipIf(!dockerOk)('P4-4 — federated invite creation', () => {
  beforeEach(async () => {
    if (!dockerOk) return;
    await prisma.auditLogEntry.deleteMany({});
    await prisma.invite.deleteMany({});
    await prisma.apiToken.deleteMany({});
    await prisma.serverMember.deleteMany({});
    await prisma.permissionOverwrite.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.channel.deleteMany({});
    await prisma.server.deleteMany({});
    await prisma.remoteInstance.deleteMany({});
    await prisma.user.deleteMany({});
    vi.restoreAllMocks();
  });

  // ---- Happy paths ---------------------------------------------------------

  it('creates an any_peer invite — host and user are null on the row and in the response', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'any_peer',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as InviteResponse;
      expect(body.data.scope).toBe('server');
      expect(body.data.serverId).toBe(fx.fedServerId);
      expect(body.data.remoteScope).toBe('any_peer');
      expect(body.data.remoteInstanceHost).toBeNull();
      expect(body.data.remoteUserId).toBeNull();

      const row = await prisma.invite.findUnique({ where: { id: body.data.id } });
      expect(row?.remoteScope).toBe('any_peer');
      expect(row?.remoteInstanceHost).toBeNull();
      expect(row?.remoteUserId).toBeNull();

      // Audit log surfaces the federated metadata.
      const audit = await prisma.auditLogEntry.findFirst({
        where: { action: 'invite.created', targetId: body.data.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.metadata).toMatchObject({
        scope: 'server',
        remoteScope: 'any_peer',
        remoteInstanceHost: null,
        remoteUserId: null,
      });
    } finally {
      await app.close();
    }
  });

  it('creates a specific_instance invite — host is persisted, user remains null', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_instance',
          remoteInstanceHost: fx.peeredHost,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as InviteResponse;
      expect(body.data.remoteScope).toBe('specific_instance');
      expect(body.data.remoteInstanceHost).toBe(fx.peeredHost);
      expect(body.data.remoteUserId).toBeNull();

      const row = await prisma.invite.findUnique({ where: { id: body.data.id } });
      expect(row?.remoteInstanceHost).toBe(fx.peeredHost);
      expect(row?.remoteUserId).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('creates a specific_user invite — both host and remoteUserId are persisted (host derived from user id)', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const remoteUserId = `alice@${fx.peeredHost}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_user',
          remoteUserId,
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as InviteResponse;
      expect(body.data.remoteScope).toBe('specific_user');
      // Host is derived from the user-id even though the caller didn't send it
      // — guards against rename-widening at the peer.
      expect(body.data.remoteInstanceHost).toBe(fx.peeredHost);
      expect(body.data.remoteUserId).toBe(remoteUserId);

      const row = await prisma.invite.findUnique({ where: { id: body.data.id } });
      expect(row?.remoteInstanceHost).toBe(fx.peeredHost);
      expect(row?.remoteUserId).toBe(remoteUserId);
    } finally {
      await app.close();
    }
  });

  it('regression: local invite creation (no remoteScope) still works and leaves federated fields null', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        // Non-federated Tavern is fine when no remoteScope is requested.
        payload: { scope: 'server', serverId: fx.localServerId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as InviteResponse;
      expect(body.data.remoteScope).toBeNull();
      expect(body.data.remoteInstanceHost).toBeNull();
      expect(body.data.remoteUserId).toBeNull();
    } finally {
      await app.close();
    }
  });

  // ---- Validation failures (cases 1-8 from the spec) -----------------------

  it('case 1: remoteScope on a non-server-scoped invite is rejected', async () => {
    const fx = await makeFixture();
    // The actor needs to be an instance admin for the instance-scope branch
    // to even reach the federation block.
    await prisma.user.update({ where: { id: fx.ownerId }, data: { isInstanceAdmin: true } });
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: { scope: 'instance', remoteScope: 'any_peer' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as ErrorResponse;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toMatch(/server-scoped/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 2: target server is not federation-enabled', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.localServerId,
          remoteScope: 'any_peer',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as ErrorResponse;
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.message).toMatch(/federation-enabled/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 3: any_peer with remoteInstanceHost or remoteUserId is rejected', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);

      // With remoteInstanceHost.
      const withHost = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'any_peer',
          remoteInstanceHost: fx.peeredHost,
        },
      });
      expect(withHost.statusCode).toBe(400);
      expect((withHost.json() as ErrorResponse).error.code).toBe('VALIDATION_ERROR');
      expect((withHost.json() as ErrorResponse).error.message).toMatch(/any_peer/);

      // With remoteUserId.
      const withUser = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'any_peer',
          remoteUserId: `alice@${fx.peeredHost}`,
        },
      });
      expect(withUser.statusCode).toBe(400);
      expect((withUser.json() as ErrorResponse).error.message).toMatch(/any_peer/);

      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 4: specific_instance without remoteInstanceHost is rejected', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_instance',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorResponse).error.message).toMatch(/remoteInstanceHost/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 5: specific_instance with a non-peered host is rejected', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);

      // Completely unknown host.
      const unknown = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_instance',
          remoteInstanceHost: 'never-peered.example',
        },
      });
      expect(unknown.statusCode).toBe(400);
      expect((unknown.json() as ErrorResponse).error.message).toMatch(/not a peered instance/);

      // Known host whose status is pending — also rejected.
      const pending = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_instance',
          remoteInstanceHost: fx.pendingHost,
        },
      });
      expect(pending.statusCode).toBe(400);
      expect((pending.json() as ErrorResponse).error.message).toMatch(/not a peered instance/);

      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 6: specific_user without remoteUserId is rejected', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_user',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorResponse).error.message).toMatch(/remoteUserId/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('case 7: specific_user with a malformed remoteUserId is rejected', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      // No @.
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_user',
          remoteUserId: 'alice-no-at-sign',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorResponse).error.message).toMatch(/malformed|localpart@host/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("case 8: specific_user whose host portion isn't a peered instance is rejected", async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      const token = await mintToken(fx.ownerId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'specific_user',
          remoteUserId: 'alice@never-peered.example',
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorResponse).error.message).toMatch(/host is not a peered instance/);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  // ---- Permission gate -----------------------------------------------------

  it('rejects a regular member (no CREATE_INVITES) with 403 even with valid federated fields', async () => {
    const fx = await makeFixture();
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp({
      config: loadConfig(envFor(ctx!.databaseUrl)),
      queuesOverride: {
        enqueueScan: vi.fn(async () => undefined),
        enqueueFederationOutbox: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    });
    try {
      // Sanity: the default @everyone role does NOT include CREATE_INVITES or
      // MANAGE_SERVER, so the member token here mirrors a real non-admin.
      expect((PERMISSION_DEFAULT_EVERYONE & Permission.CREATE_INVITES) === 0n).toBe(true);

      const memberToken = await mintToken(fx.memberId);
      const res = await app.inject({
        method: 'POST',
        url: '/api/invites',
        headers: { authorization: `Bearer ${memberToken}` },
        payload: {
          scope: 'server',
          serverId: fx.fedServerId,
          remoteScope: 'any_peer',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.invite.count()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
