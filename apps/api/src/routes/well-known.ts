import type { FastifyInstance } from 'fastify';
import { CAPABILITIES, PROTOCOL_VERSION, WELL_KNOWN_PATH, type Capability } from '@tavern/shared';
import type { FederationKeyStore } from '../services/federation-keys.js';
import type { Config } from '../config.js';

export interface WellKnownDeps {
  keys: FederationKeyStore;
  config: Config;
  softwareVersion: string;
}

/**
 * Compute the capability set this instance advertises in its .well-known doc.
 * Starts from the static shared `CAPABILITIES` list and removes any capability
 * the operator has opted out of via env (P5-11: `FEDERATION_DMS_ENABLED`;
 * P6-2: `FEDERATION_PRESENCE_ENABLED`).
 *
 * Exported so the peering service can reuse the same filtering logic when
 * intersecting requested + advertised capabilities at handshake time.
 */
export function advertisedCapabilities(
  config: Pick<Config, 'FEDERATION_DMS_ENABLED' | 'FEDERATION_PRESENCE_ENABLED'>,
): Capability[] {
  return CAPABILITIES.filter((cap) => {
    if (cap === 'dms' && !config.FEDERATION_DMS_ENABLED) return false;
    if (cap === 'presence' && !config.FEDERATION_PRESENCE_ENABLED) return false;
    return true;
  });
}

export function registerWellKnownRoutes(app: FastifyInstance, deps: WellKnownDeps): void {
  // Public. No requireUser — this is how peers discover our keys.
  app.get(WELL_KNOWN_PATH, {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (_req, reply) => {
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
        capabilities: advertisedCapabilities(deps.config),
      });
    },
  });
}
