import type { FastifyInstance } from 'fastify';
import { CAPABILITIES, PROTOCOL_VERSION, WELL_KNOWN_PATH } from '@tavern/shared';
import type { FederationKeyStore } from '../services/federation-keys.js';
import type { Config } from '../config.js';

export interface WellKnownDeps {
  keys: FederationKeyStore;
  config: Config;
  softwareVersion: string;
}

export function registerWellKnownRoutes(app: FastifyInstance, deps: WellKnownDeps): void {
  // Public. No requireUser — this is how peers discover our keys.
  app.get(WELL_KNOWN_PATH, async (_req, reply) => {
    const baseUrl = new URL(deps.config.PUBLIC_BASE_URL);
    const host = baseUrl.host;
    const httpsBase = `${baseUrl.protocol}//${host}`;
    const wssBase = baseUrl.protocol === 'https:' ? `wss://${host}` : `ws://${host}`;
    reply.send({
      instance: host,
      softwareVersion: deps.softwareVersion,
      protocolVersion: PROTOCOL_VERSION,
      instanceKey: deps.keys.getPublicKeyAdvertised(),
      endpoints: {
        peering: `${httpsBase}/_federation/peering`,
        events: `${wssBase}/_federation/events`, // not implemented in phase 1
        backfill: `${httpsBase}/_federation/backfill`, // not implemented in phase 1
      },
      capabilities: [...CAPABILITIES],
    });
  });
}
