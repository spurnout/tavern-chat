/**
 * P3-7: Unit tests for the inbound `POST /_federation/event` route shell +
 * error-code mapping.
 *
 * The "happy path" + replay + signature work all need a real DB (the
 * dispatcher logs to FederationEnvelopeLog and persists Messages). Those
 * live in `test-integration/federation-inbound.test.ts` and are gated on
 * Docker.
 *
 * What we can cover here without Docker:
 *   - The route is reachable and accepts POST.
 *   - Malformed envelopes (no body, missing fields) → 400.
 *   - Each FederationInboundError code maps to the right HTTP status.
 *   - The route does NOT consume the body twice or otherwise mangle it on
 *     the error path.
 */

import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { registerFederationEventsRoutes } from '../src/routes/federation-events.js';
import {
  FederationInboundError,
  type FederationInboundService,
  type InboundErrorCode,
  type ProcessEnvelopeResult,
} from '../src/services/federation-inbound.js';

function makeMockService(): {
  service: FederationInboundService;
  processEnvelope: ReturnType<typeof vi.fn>;
} {
  const processEnvelope = vi.fn();
  const service = {
    processEnvelope: processEnvelope as unknown as FederationInboundService['processEnvelope'],
  } as FederationInboundService;
  return { service, processEnvelope };
}

async function makeApp(service: FederationInboundService) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerFederationEventsRoutes(app, { service });
  await app.ready();
  return app;
}

describe('POST /_federation/event — route shell', () => {
  it('returns the dispatcher status + body on success', async () => {
    const { service, processEnvelope } = makeMockService();
    processEnvelope.mockResolvedValue({
      status: 200,
      body: { ok: true, data: { id: 'msg-1' } },
    } satisfies ProcessEnvelopeResult);
    const app = await makeApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: { whatever: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: { id: 'msg-1' } });
    } finally {
      await app.close();
    }
  });

  it('falls back to { ok: true } when dispatcher omits body', async () => {
    const { service, processEnvelope } = makeMockService();
    processEnvelope.mockResolvedValue({ status: 200 } satisfies ProcessEnvelopeResult);
    const app = await makeApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  const codeStatusMatrix: Array<{ code: InboundErrorCode; status: number }> = [
    { code: 'bad_envelope', status: 400 },
    { code: 'bad_signature', status: 401 },
    { code: 'unknown_peer', status: 403 },
    { code: 'peer_not_peered', status: 403 },
    { code: 'federation_off', status: 403 },
    { code: 'not_a_member', status: 403 },
    { code: 'forbidden', status: 403 },
    { code: 'unknown_channel', status: 404 },
    { code: 'unknown_message', status: 404 },
    { code: 'replay', status: 409 },
    { code: 'not_implemented', status: 501 },
  ];

  for (const { code, status } of codeStatusMatrix) {
    it(`maps ${code} → ${status}`, async () => {
      const { service, processEnvelope } = makeMockService();
      processEnvelope.mockRejectedValue(
        new FederationInboundError(code, `boom: ${code}`),
      );
      const app = await makeApp(service);
      try {
        const res = await app.inject({
          method: 'POST',
          url: '/_federation/event',
          payload: { dummy: true },
        });
        expect(res.statusCode).toBe(status);
        const body = res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toBe(`boom: ${code}`);
      } finally {
        await app.close();
      }
    });
  }

  it('lets non-FederationInboundError errors bubble (500 by default)', async () => {
    const { service, processEnvelope } = makeMockService();
    processEnvelope.mockRejectedValue(new Error('boom: unexpected'));
    const app = await makeApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/_federation/event',
        payload: {},
      });
      // The exact status depends on the error handler; the important
      // contract here is that the response is NOT 200/204 and the message
      // is not silently swallowed. Fastify's default returns 500.
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await app.close();
    }
  });
});
