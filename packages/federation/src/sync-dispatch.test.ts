/**
 * Unit tests for `postFederationEventSync`.
 *
 * The helper has three responsibilities — SSRF-guarding the peer host,
 * POSTing the envelope, and verifying the response envelope's signature +
 * schema. Each test isolates one of those by injecting a stubbed `fetchImpl`
 * and feeding a hand-built response envelope.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalize } from './canonical-json.js';
import { generateKeyPair, sign as edSign, exportPublicKeyRaw } from './ed25519.js';
import { postFederationEventSync, type SingleLayerSignedEnvelope } from './sync-dispatch.js';
import {
  PROTOCOL_VERSION,
  ENVELOPE_DEFAULT_LIFETIME_S,
  ulid,
} from '@tavern/shared';

const SELF_HOST = 'b.example';
const PEER_HOST = 'a.example';

const fakeOutgoingEnvelope = {
  version: PROTOCOL_VERSION,
  eventType: 'member.join_request' as const,
  nonce: ulid(),
  notBefore: new Date().toISOString(),
  notAfter: new Date(Date.now() + 60_000).toISOString(),
  fromInstance: SELF_HOST,
  toInstance: PEER_HOST,
  payload: { inviteCode: 'X', joinerRemoteUserId: `joiner@${SELF_HOST}` },
  userSignature: 'AAAA',
  signature: 'BBBB',
};

const responseSchema = z.object({ ok: z.literal(true), serverId: z.string() });

/** Build a fresh response envelope signed by the given peer keypair. */
function buildReply(opts: {
  peerKp: ReturnType<typeof generateKeyPair>;
  payload?: { ok: true; serverId: string };
  toInstance?: string;
  fromInstance?: string;
  notBefore?: Date;
  notAfter?: Date;
  signKp?: ReturnType<typeof generateKeyPair>;
}): SingleLayerSignedEnvelope<{ ok: true; serverId: string }> {
  const payload = opts.payload ?? { ok: true, serverId: 'srv-1' };
  const now = Date.now();
  const notBefore = opts.notBefore ?? new Date(now);
  const notAfter =
    opts.notAfter ?? new Date(now + ENVELOPE_DEFAULT_LIFETIME_S * 1000);
  const unsigned = {
    version: PROTOCOL_VERSION,
    eventType: 'member.joined' as const,
    nonce: ulid(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    fromInstance: opts.fromInstance ?? PEER_HOST,
    toInstance: opts.toInstance ?? SELF_HOST,
    payload,
  };
  const signKp = opts.signKp ?? opts.peerKp;
  const sigBytes = edSign(
    Buffer.from(canonicalize(unsigned as unknown), 'utf8'),
    signKp.privateKey,
  );
  return {
    ...unsigned,
    signature: sigBytes.toString('base64'),
  } as SingleLayerSignedEnvelope<{ ok: true; serverId: string }>;
}

function fakeFetch(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

describe('postFederationEventSync', () => {
  it('returns ok:true with verified payload on 200 + signed envelope', async () => {
    const peerKp = generateKeyPair();
    const reply = buildReply({ peerKp });
    const res = new Response(JSON.stringify(reply), { status: 200 });

    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.payload).toEqual({ ok: true, serverId: 'srv-1' });
    }
  });

  it('returns ok:false with status + reason on 4xx', async () => {
    const peerKp = generateKeyPair();
    const res = new Response('invite not found', { status: 404 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(404);
      expect(out.reason).toContain('invite not found');
    }
  });

  it('returns ok:false on 5xx', async () => {
    const peerKp = generateKeyPair();
    const res = new Response('server crashed', { status: 503 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.status).toBe(503);
  });

  it('returns ok:false when the response signature is signed by a different key', async () => {
    const peerKp = generateKeyPair();
    const attackerKp = generateKeyPair();
    const reply = buildReply({ peerKp, signKp: attackerKp }); // wrong sig
    const res = new Response(JSON.stringify(reply), { status: 200 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/signature does not verify/i);
  });

  it('rejects a response with toInstance mismatch', async () => {
    const peerKp = generateKeyPair();
    const reply = buildReply({ peerKp, toInstance: 'someone-else.example' });
    const res = new Response(JSON.stringify(reply), { status: 200 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/toInstance/);
  });

  it('rejects a response with fromInstance mismatch', async () => {
    const peerKp = generateKeyPair();
    const reply = buildReply({ peerKp, fromInstance: 'someone-else.example' });
    const res = new Response(JSON.stringify(reply), { status: 200 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/fromInstance/);
  });

  it('rejects an expired response envelope (notAfter in the past)', async () => {
    const peerKp = generateKeyPair();
    const reply = buildReply({
      peerKp,
      notBefore: new Date(Date.now() - 10_000_000),
      notAfter: new Date(Date.now() - 9_000_000),
    });
    const res = new Response(JSON.stringify(reply), { status: 200 });
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: fakeFetch(res),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/notAfter expired/i);
  });

  it('SSRF-guards peer hosts that are bare IPv4', async () => {
    const peerKp = generateKeyPair();
    await expect(() =>
      postFederationEventSync({
        peerHost: '127.0.0.1',
        envelope: fakeOutgoingEnvelope,
        expectedPayloadSchema: responseSchema,
        peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
        selfHost: SELF_HOST,
        fetchImpl: fakeFetch(new Response('{}', { status: 200 })),
      }),
    ).rejects.toThrow(/peer host must be a hostname/i);
  });

  it('SSRF-guards localhost', async () => {
    const peerKp = generateKeyPair();
    await expect(() =>
      postFederationEventSync({
        peerHost: 'localhost',
        envelope: fakeOutgoingEnvelope,
        expectedPayloadSchema: responseSchema,
        peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
        selfHost: SELF_HOST,
        fetchImpl: fakeFetch(new Response('{}', { status: 200 })),
      }),
    ).rejects.toThrow(/localhost/i);
  });

  it('returns ok:false on network errors (fetch throws)', async () => {
    const peerKp = generateKeyPair();
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const out = await postFederationEventSync({
      peerHost: PEER_HOST,
      envelope: fakeOutgoingEnvelope,
      expectedPayloadSchema: responseSchema,
      peerPublicKeyRaw: exportPublicKeyRaw(peerKp.publicKey),
      selfHost: SELF_HOST,
      fetchImpl: throwingFetch,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(0);
      expect(out.reason).toMatch(/network error/i);
    }
  });
});
