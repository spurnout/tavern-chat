import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { FederationProfileService } from '../services/federation-profile.js';

export interface UsersFederatedDeps {
  service: FederationProfileService;
}

export function registerUsersFederatedRoutes(
  app: FastifyInstance,
  deps: UsersFederatedDeps,
): void {
  app.get('/api/federation/users/:remoteUserId/profile', async (req, reply) => {
    // Any authenticated user can look up a remote user profile — same threat
    // model as the existing per-server profile endpoint (federation profiles
    // are advertised by the home instance via signed envelopes; there's no
    // private info to gate beyond "are you a real user on this Tavern").
    await app.requireUser(req, reply);

    const params = z.object({
      remoteUserId: z.string().min(3).max(253),
    }).parse(req.params);

    try {
      const profile = await deps.service.fetchRemoteProfile(params.remoteUserId);
      reply.send(
        ok({
          remoteUserId: profile.remoteUserId,
          displayName: profile.displayNameCache,
          avatarUrl: profile.avatarUrlCache,
          homeInstanceHost: profile.remoteUserId.split('@')[1] ?? '',
          publicKey: `ed25519:${profile.publicKey.toString('base64')}`,
          lastSeenAt: profile.lastSeenAt.toISOString(),
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      // Distinguish failure modes for the client.
      if (msg.startsWith('invalid remoteUserId')) {
        throw TavernError.validation(msg);
      }
      if (msg.includes('is not a peered remote instance')) {
        throw TavernError.notFound(`peer not federated: ${msg}`);
      }
      // Anything else (network, signature, schema) → 502.
      reply.code(502).send({ ok: false, error: { code: 'INTERNAL_ERROR', message: `could not fetch remote profile: ${msg}` } });
    }
  });
}
