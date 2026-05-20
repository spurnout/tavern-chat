/**
 * Unit tests for GET /api/federation/users/:remoteUserId/profile
 *
 * We construct a minimal Fastify app with the auth decorator and a mock service
 * so we can exercise the route's auth gate and input validation without
 * needing Docker, Postgres, or real federation keys.
 */

import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAuthPlugin } from '../src/plugins/auth.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { registerUsersFederatedRoutes } from '../src/routes/users-federated.js';
import type { FederationProfileService } from '../src/services/federation-profile.js';
import type { JwtService } from '../src/lib/jwt.js';

// The auth plugin calls prisma internally. Mock the module so no DB is needed.
vi.mock('@tavern/db', () => ({
  prisma: {
    session: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    apiToken: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  disconnectPrisma: async () => undefined,
}));

function makeMockService(): FederationProfileService {
  return {
    fetchRemoteProfile: vi.fn().mockRejectedValue(new Error('not called')),
    respondToProfileRequest: vi.fn(),
    getCachedRemoteProfile: vi.fn(),
  } as unknown as FederationProfileService;
}

async function makeApp(service: FederationProfileService) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  const jwt = {
    verifyAccess: vi.fn().mockRejectedValue(new Error('no valid token')),
  } as unknown as JwtService;
  registerAuthPlugin(app, { jwt });
  registerUsersFederatedRoutes(app, { service });
  await app.ready();
  return app;
}

describe('GET /api/federation/users/:remoteUserId/profile', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const service = makeMockService();
    const app = await makeApp(service);

    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/users/alice@b.example/profile',
      // No Authorization header
    });

    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);

    await app.close();
  });

  it('returns 400 when the service reports invalid remoteUserId', async () => {
    const service = makeMockService();
    // Override fetchRemoteProfile to throw the "invalid remoteUserId" error
    (service.fetchRemoteProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('invalid remoteUserId: notavalidid'),
    );

    // Decorate requireUser to always succeed (bypass JWT) for this test
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorate('requireUser', async () => ({
      userId: 'user-1',
      sessionId: 'session-1',
      isInstanceAdmin: false,
    }));
    app.decorate('optionalUser', async () => null);
    registerUsersFederatedRoutes(app, { service });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/users/notavalidid/profile',
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);

    await app.close();
  });

  it('returns 404 when the peer is not federated', async () => {
    const service = makeMockService();
    (service.fetchRemoteProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('host b.example is not a peered remote instance'),
    );

    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorate('requireUser', async () => ({
      userId: 'user-1',
      sessionId: 'session-1',
      isInstanceAdmin: false,
    }));
    app.decorate('optionalUser', async () => null);
    registerUsersFederatedRoutes(app, { service });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/users/alice@b.example/profile',
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);

    await app.close();
  });

  it('returns 502 for network / signature errors', async () => {
    const service = makeMockService();
    (service.fetchRemoteProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED connecting to b.example'),
    );

    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.decorate('requireUser', async () => ({
      userId: 'user-1',
      sessionId: 'session-1',
      isInstanceAdmin: false,
    }));
    app.decorate('optionalUser', async () => null);
    registerUsersFederatedRoutes(app, { service });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/federation/users/alice@b.example/profile',
      headers: { authorization: 'Bearer fake-token' },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json() as { ok: boolean; error?: { code: string; message: string } };
    expect(body.ok).toBe(false);

    await app.close();
  });
});
