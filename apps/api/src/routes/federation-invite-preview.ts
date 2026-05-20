/**
 * Federation Phase 4 — `GET /_federation/invite-preview/:code`.
 *
 * Public, NO authentication. The receiving instance fetches this on behalf
 * of its user when they paste an invite code from another Tavern, so it
 * can show them what they're about to join before committing the join.
 *
 * Caller-identification for the scope check is done via two CUSTOM
 * REQUEST HEADERS (not query params, not body — GETs have no body, and
 * keeping these out of the URL means they don't show up in logs/caches):
 *
 *   X-Tavern-Federation-Caller-Host: b.example
 *     Required for `specific_instance` AND `specific_user` scopes.
 *     Must match the host pinned on the invite AND that host must
 *     currently be a peered RemoteInstance.
 *
 *   X-Tavern-Federation-Caller-User: alice@b.example
 *     Required additionally for `specific_user` scope. Must match
 *     `invite.remoteUserId`.
 *
 * The headers are an honour-system declaration of who the receiving
 * instance is fetching on behalf of — this endpoint is metadata-only, and
 * the *real* authorisation happens when the receiving instance posts a
 * `member.join_request` envelope (which is signed by the joining user and
 * the receiving instance, P4-6+). The scope check here exists so a
 * malicious peer C can't trivially harvest invite metadata for invites
 * minted for peer B.
 *
 * Rate limit: 30 requests/minute per source IP (Fastify @fastify/rate-limit
 * default key derivation).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, fail } from '../lib/responses.js';
import {
  PreviewError,
  previewFederatedInvite,
  type PreviewErrorCode,
} from '../services/federation-invite-preview.js';

export interface FederationInvitePreviewRouteDeps {
  selfHost: string;
}

// Lenient: invite codes are server-minted opaque strings; we don't bother
// rejecting bad codes early — `unknown_invite` covers them in the service.
const codeSchema = z.object({ code: z.string().min(1).max(64) });

export function registerFederationInvitePreviewRoutes(
  app: FastifyInstance,
  deps: FederationInvitePreviewRouteDeps,
): void {
  app.get<{ Params: { code: string } }>(
    '/_federation/invite-preview/:code',
    {
      // Public-internet endpoint with NO auth — rate-limit per source IP so
      // a peer can't enumerate codes by brute force. 30/min lines up with
      // the existing "modest" tier (see reactions: 60/min for an
      // authenticated PUT). Keeping it well below the global 300/min cap.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      handler: async (req, reply) => {
        const { code } = codeSchema.parse(req.params);
        const callerHost = headerString(req.headers['x-tavern-federation-caller-host']);
        const callerUser = headerString(req.headers['x-tavern-federation-caller-user']);

        try {
          const data = await previewFederatedInvite({
            code,
            callerHost,
            callerUser,
            selfHost: deps.selfHost,
          });
          reply.status(200).send(ok(data));
        } catch (err) {
          if (err instanceof PreviewError) {
            const { status, code: errCode, message } = mapPreviewError(err);
            return reply.status(status).send(fail(errCode, message));
          }
          throw err;
        }
      },
    },
  );
}

/**
 * Fastify exposes repeated headers as `string | string[] | undefined`.
 * Normalise to a single string (first value if duplicated, undefined if
 * absent) so the service layer never deals with the polymorphism.
 */
function headerString(raw: string | string[] | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Translate `PreviewError.code` to (HTTP status, error envelope code,
 * human-readable message). Kept exhaustive on the union — TypeScript's
 * `never` check enforces that adding a new code requires updating the
 * mapping.
 *
 * Note on error envelope codes: `NOT_FOUND` and `PERMISSION_DENIED` are
 * shared `ErrorCode`s; `INVALID_INVITE` is the closest fit for "the
 * invite exists but is no longer valid" (revoked/expired/exhausted) —
 * existing local invite routes throw `INVALID_INVITE` for the same
 * conditions (see `routes/invites.ts`).
 */
function mapPreviewError(
  err: PreviewError,
): { status: number; code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'INVALID_INVITE'; message: string } {
  const code: PreviewErrorCode = err.code;
  switch (code) {
    case 'unknown_invite':
      return { status: 404, code: 'NOT_FOUND', message: err.message };
    case 'invite_no_longer_valid':
      return { status: 410, code: 'INVALID_INVITE', message: err.message };
    case 'forbidden':
      return { status: 403, code: 'PERMISSION_DENIED', message: err.message };
  }
}
