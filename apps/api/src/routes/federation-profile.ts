import type { FastifyInstance } from 'fastify';
import { FederationProfileService } from '../services/federation-profile.js';
import { PeeringError } from '../services/federation-peering.js';

export function registerFederationProfileRoutes(
  app: FastifyInstance,
  deps: { service: FederationProfileService },
): void {
  // Public — envelope signature is the auth.
  app.post('/_federation/profile', async (req, reply) => {
    try {
      const result = await deps.service.respondToProfileRequest(req.body);
      reply.code(200).send(result.envelope);
    } catch (err) {
      if (err instanceof PeeringError) {
        switch (err.code) {
          case 'bad_envelope':
            // Distinguish "envelope malformed" (400) from "user not found" (404).
            // Use 404 when the message says "no user ... on this instance".
            if (err.message.startsWith('no user')) {
              return reply.code(404).send({ success: false, error: err.message });
            }
            return reply.code(400).send({ success: false, error: err.message });
          case 'signature':
            return reply.code(401).send({ success: false, error: err.message });
          case 'blocked':
            return reply.code(403).send({ success: false, error: err.message });
          case 'replay':
          case 'unreachable':
            return reply.code(409).send({ success: false, error: err.message });
        }
      }
      throw err;
    }
  });
}
