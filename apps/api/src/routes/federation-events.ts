/**
 * Federation Phase 3 — `POST /_federation/event`.
 *
 * Public route. The envelope's two-layer signature IS the authentication —
 * the route doesn't read any session / API token, only the body. Everything
 * meaningful lives in `FederationInboundService.processEnvelope`; this file
 * is the thin translator from `FederationInboundError.code` to HTTP status.
 *
 * Mirrors the shape of `routes/federation-profile.ts` and
 * `routes/federation-peering.ts` — three thin try/catch wrappers around their
 * respective service methods.
 */

import type { FastifyInstance } from 'fastify';
import {
  FederationInboundError,
  FederationInboundService,
} from '../services/federation-inbound.js';

export function registerFederationEventsRoutes(
  app: FastifyInstance,
  deps: { service: FederationInboundService },
): void {
  app.post('/_federation/event', async (req, reply) => {
    try {
      const result = await deps.service.processEnvelope(req.body);
      reply.code(result.status).send(result.body ?? { ok: true });
    } catch (err) {
      if (err instanceof FederationInboundError) {
        const status = statusForCode(err.code);
        return reply.code(status).send({ success: false, error: err.message });
      }
      throw err;
    }
  });
}

/**
 * Mapping table — keep aligned with the codes defined in
 * `federation-inbound.ts`. New codes added in P3-8 / P3-9 must update this
 * function (TypeScript exhaustiveness check on the switch enforces that).
 */
function statusForCode(code: FederationInboundError['code']): number {
  switch (code) {
    case 'bad_envelope':
      return 400;
    case 'bad_signature':
      return 401;
    case 'unknown_peer':
    case 'peer_not_peered':
    case 'federation_off':
    case 'not_a_member':
    case 'forbidden':
      return 403;
    case 'unknown_channel':
    case 'unknown_message':
    case 'unknown_invite':
      return 404;
    case 'replay':
      return 409;
    case 'invite_no_longer_valid':
      return 410;
    case 'not_implemented':
      return 501;
  }
}
