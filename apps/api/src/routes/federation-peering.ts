import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/responses.js';
import { FederationPeeringService, PeeringError } from '../services/federation-peering.js';

export function registerFederationPeeringRoutes(
  app: FastifyInstance,
  deps: { service: FederationPeeringService },
): void {
  // Public — envelope signature IS the authentication.
  app.post('/_federation/peering', async (req, reply) => {
    try {
      const result = await deps.service.recordInboundRequest(req.body);
      reply.code(202).send(ok({ id: result.logId, remoteInstanceId: result.remoteInstanceId }));
    } catch (err) {
      if (err instanceof PeeringError) {
        switch (err.code) {
          case 'bad_envelope':
            return reply.code(400).send({ success: false, error: err.message });
          case 'signature':
            return reply.code(401).send({ success: false, error: err.message });
          case 'replay':
            return reply.code(409).send({ success: false, error: err.message });
          case 'blocked':
            return reply.code(403).send({ success: false, error: err.message });
          case 'unreachable':
            return reply.code(502).send({ success: false, error: err.message });
        }
      }
      throw err;
    }
  });
}
