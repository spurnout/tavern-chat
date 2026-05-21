/**
 * Federation Phase 4 / P4-16 — authenticated browser-facing passthrough for
 * federated invite previews.
 *
 *   `GET /api/federation/invite-preview?host=<peerHost>&code=<inviteCode>`
 *
 * Why a passthrough and not a direct browser call to the home? Three reasons:
 *
 *   1. **Cross-origin.** The web client lives on B (`b.example`). A federated
 *      invite is minted by A (`a.example`) and previewed at
 *      `https://a.example/_federation/invite-preview/{code}`. Calling that
 *      directly from the SPA hits CORS and would also leak the joiner's IP
 *      to A before the join is even confirmed.
 *   2. **Peering check on B.** Even before we make a network call, we want to
 *      refuse if the operator hasn't peered with A — otherwise a malicious
 *      link in the wild could turn any logged-in B user into a probe against
 *      arbitrary public Tavern hosts.
 *   3. **Server-side caller identity headers.** The home's preview endpoint
 *      uses `X-Tavern-Federation-Caller-Host` (and `-Caller-User` for
 *      `specific_user` scoped invites) for its scope gate. Setting those
 *      from the server-side is the only place we can do it accurately — the
 *      browser doesn't know its instance host, and a hostile SPA build
 *      couldn't be trusted to send the truth anyway.
 *
 * Flow:
 *   1. `requireUser` — must be a logged-in user on B.
 *   2. Validate query params (`host`, `code`).
 *   3. Look up the `RemoteInstance` by host. Must be `status='peered'`; else 403.
 *   4. Build the qualified caller-user id (`<localpart>@<selfHost>`) and POST
 *      to `https://{host}/_federation/invite-preview/{code}` with the caller
 *      headers.
 *   5. Pass back the preview JSON on success, or surface the home's error code.
 *
 * Rate limiting: shares the global 300/min cap; no extra route-specific limit.
 * The home's own preview endpoint is rate-limited at 30/min per source IP,
 * which from the home's perspective is B's IP — so the cap there is per-
 * sending-instance, not per-end-user.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@tavern/db';
import {
  federatedInvitePreviewSchema,
  TavernError,
  type FederatedInvitePreview,
} from '@tavern/shared';
import { assertValidPeerHost } from '@tavern/federation';
import { ok, fail } from '../lib/responses.js';

const querySchema = z.object({
  host: z.string().min(1).max(253),
  code: z.string().min(1).max(64),
});

/**
 * The home's response envelope is the standard `{ ok: true, data: ... }`
 * shape. We parse it here so we can both validate against the published
 * preview schema and surface meaningful error messages if the home
 * misbehaves.
 */
const homeResponseSchema = z.union([
  z.object({ ok: z.literal(true), data: federatedInvitePreviewSchema }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
]);

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FederationInvitePreviewProxyRouteDeps {
  /** This instance's federation host (e.g. `b.example`). Required header on outbound. */
  selfHost: string;
  /** Override fetch impl (used by tests). */
  fetchImpl?: typeof fetch;
  /** Override the per-call timeout (default 10s). */
  timeoutMs?: number;
}

export function registerFederationInvitePreviewProxyRoutes(
  app: FastifyInstance,
  deps: FederationInvitePreviewProxyRouteDeps,
): void {
  app.get('/api/federation/invite-preview', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(fail('VALIDATION_ERROR', 'host and code query params are required'));
    }
    const { host, code } = parsed.data;

    // SSRF guard. Same shape as outbox dispatch / sync dispatch — we don't
    // trust DB-pinned hosts blindly even though peering admission already
    // checks. Defence in depth.
    try {
      assertValidPeerHost(host);
    } catch (err) {
      return reply
        .code(400)
        .send(fail('VALIDATION_ERROR', err instanceof Error ? err.message : 'invalid peer host'));
    }

    // Peering check on B. A federated invite preview only makes sense if the
    // operator has actually peered with the host; same scope-leak rationale
    // as on A's side. Returning the same code as the home's "forbidden" path
    // keeps the SPA's error handling uniform.
    const peer = await prisma.remoteInstance.findUnique({
      where: { host },
      select: { id: true, status: true },
    });
    if (!peer || peer.status !== 'peered') {
      return reply
        .code(403)
        .send(fail('PERMISSION_DENIED', `host ${host} is not a peered instance`));
    }

    // Caller identity — used by A's preview gate for `specific_user`-scoped
    // invites. We always send it; A only consults it when the invite scope
    // requires it.
    const me = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { username: true },
    });
    if (!me) {
      throw TavernError.notFound('Caller user not found');
    }
    const callerUser = `${me.username}@${deps.selfHost}`;

    const url = `https://${host}/_federation/invite-preview/${encodeURIComponent(code)}`;
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'X-Tavern-Federation-Caller-Host': deps.selfHost,
          'X-Tavern-Federation-Caller-User': callerUser,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      app.log.warn({ err, host, code }, 'federated invite preview proxy fetch failed');
      return reply
        .code(502)
        .send(
          fail(
            'INTERNAL_ERROR',
            `could not reach ${host} (${err instanceof Error ? err.message : 'fetch failed'})`,
          ),
        );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return reply
        .code(502)
        .send(fail('INTERNAL_ERROR', `home returned non-JSON response (status ${res.status})`));
    }

    const parsedBody = homeResponseSchema.safeParse(body);
    if (!parsedBody.success) {
      app.log.warn(
        { host, code, issues: parsedBody.error.issues },
        'federated invite preview: home response did not match expected schema',
      );
      return reply
        .code(502)
        .send(fail('INTERNAL_ERROR', `home returned a response in an unexpected shape`));
    }

    if (parsedBody.data.ok === false) {
      // Pass through the home's error code + message verbatim. We map the
      // upstream code/status onto our local envelope so the SPA's existing
      // error-handling treats it like any other API failure. 404 + 410 + 403
      // are the documented codes from the home's preview route.
      const upstreamCode = parsedBody.data.error.code;
      const upstreamMsg = parsedBody.data.error.message;
      const errorCode: 'NOT_FOUND' | 'INVALID_INVITE' | 'PERMISSION_DENIED' | 'INTERNAL_ERROR' =
        upstreamCode === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : upstreamCode === 'INVALID_INVITE'
            ? 'INVALID_INVITE'
            : upstreamCode === 'PERMISSION_DENIED'
              ? 'PERMISSION_DENIED'
              : 'INTERNAL_ERROR';
      return reply.code(res.status).send(fail(errorCode, upstreamMsg));
    }

    const preview: FederatedInvitePreview = parsedBody.data.data;
    return reply.code(200).send(ok(preview));
  });
}
