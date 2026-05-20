import { z } from 'zod';
import { ENVELOPE_EVENT_TYPES, PROTOCOL_VERSION } from './constants.js';

const isoDateTime = z.string().datetime({ offset: true });

export function envelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z
    .object({
      version: z.literal(PROTOCOL_VERSION),
      eventType: z.enum(ENVELOPE_EVENT_TYPES),
      nonce: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/, 'nonce must be ULID/base32/base64url characters'),
      notBefore: isoDateTime,
      notAfter: isoDateTime,
      fromInstance: z.string().min(1).max(253),
      toInstance: z.string().min(1).max(253),
      payload,
      signature: z.string().min(1),
    })
    .superRefine((env, ctx) => {
      if (Date.parse(env.notAfter) <= Date.parse(env.notBefore)) {
        ctx.addIssue({
          code: 'custom',
          message: 'notAfter must be strictly after notBefore',
          path: ['notAfter'],
        });
      }
    });
}

export type EnvelopeOf<T extends z.ZodTypeAny> = z.infer<ReturnType<typeof envelopeSchema<T>>>;
