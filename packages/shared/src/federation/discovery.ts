import { z } from 'zod';
import { CAPABILITIES, PROTOCOL_VERSION } from './constants.js';

export const discoveryDocSchema = z.object({
  instance: z.string().min(1).max(253),
  softwareVersion: z.string().min(1).max(80),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  instanceKey: z.string().regex(/^ed25519:[A-Za-z0-9+/]+=*$/, 'expected ed25519:<base64>'),
  endpoints: z.object({
    peering: z.string().url(),
    events: z.string().url(),
    backfill: z.string().url(),
  }),
  capabilities: z.array(z.enum(CAPABILITIES)),
});

export type DiscoveryDoc = z.infer<typeof discoveryDocSchema>;
