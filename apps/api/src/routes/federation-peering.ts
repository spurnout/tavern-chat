import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/responses.js';
import {
  FederationPeeringService,
  PeeringError,
  type RecordInboundResult,
} from '../services/federation-peering.js';

export function registerFederationPeeringRoutes(
  app: FastifyInstance,
  deps: { service: FederationPeeringService },
): void {
  // Public — envelope signature IS the authentication.
  app.post('/_federation/peering', async (req, reply) => {
    try {
      // P6-3 (follow-up #29) — dispatch on envelope eventType. The legacy
      // route only handled `peering.request`; the initiator now also receives
      // `peering.accept` envelopes so it can reconcile the peer's accepted
      // capability set without a manual re-handshake.
      const eventType = (req.body as { eventType?: unknown } | null)?.eventType;
      let result: RecordInboundResult;
      if (eventType === 'peering.request') {
        result = await deps.service.recordInboundRequest(req.body);
      } else if (eventType === 'peering.accept') {
        result = await deps.service.recordInboundAccept(req.body);
      } else {
        return reply.code(400).send({
          success: false,
          error: `unsupported eventType: ${typeof eventType === 'string' ? eventType : 'missing'}`,
        });
      }
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
