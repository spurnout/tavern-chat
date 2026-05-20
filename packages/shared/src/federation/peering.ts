import { z } from 'zod';
import { CAPABILITIES } from './constants.js';

const capabilityList = z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length);

export const peeringRequestPayloadSchema = z.object({
  requestedCapabilities: capabilityList,
  contactEmail: z.string().email().optional(),
  note: z.string().max(500).optional(),
});

export const peeringAcceptPayloadSchema = z.object({
  acceptedCapabilities: capabilityList,
  note: z.string().max(500).optional(),
});

export const peeringRevokePayloadSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type PeeringRequestPayload = z.infer<typeof peeringRequestPayloadSchema>;
export type PeeringAcceptPayload = z.infer<typeof peeringAcceptPayloadSchema>;
export type PeeringRevokePayload = z.infer<typeof peeringRevokePayloadSchema>;
