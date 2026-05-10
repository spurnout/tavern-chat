/**
 * LiveKit access token signing.
 *
 * LiveKit access tokens are HS256 JWTs with a specific claim shape that the
 * LiveKit server understands. We sign them ourselves with `jose` to avoid a
 * bulky LiveKit SDK dependency in the API process.
 *
 * Reference: https://docs.livekit.io/reference/server/access-tokens/
 */

import { SignJWT } from 'jose';

export interface LiveKitGrant {
  roomJoin: boolean;
  room: string;
  canPublish: boolean;
  canPublishData?: boolean;
  canSubscribe: boolean;
  /** "audio,video,screen_share" */
  canPublishSources?: string[];
  hidden?: boolean;
}

export interface LiveKitTokenInput {
  apiKey: string;
  apiSecret: string;
  /** Stable user identity. */
  identity: string;
  /** Display name shown to other participants. */
  name?: string | undefined;
  ttlSeconds?: number;
  grant: LiveKitGrant;
  metadata?: Record<string, unknown>;
}

export async function signLiveKitToken(input: LiveKitTokenInput): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const ttl = input.ttlSeconds ?? 60 * 60; // 1h default
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const secret = new TextEncoder().encode(input.apiSecret);

  const claims: Record<string, unknown> = {
    sub: input.identity,
    name: input.name,
    nbf: Math.floor(Date.now() / 1000) - 5,
    iss: input.apiKey,
    video: input.grant,
  };
  if (input.metadata) claims.metadata = JSON.stringify(input.metadata);

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { token, expiresAt };
}
