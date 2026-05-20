/**
 * Integration smoke test for the federation Phase 1 schema
 * (RemoteInstance, FederationKey, FederationEnvelopeLog).
 * Verifies the three tables accept writes and basic relational constraints hold.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { ulid } from '@tavern/shared';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

describe.skipIf(!dockerOk)('federation schema (phase 1)', () => {
  it('persists a RemoteInstance row', async () => {
    const id = ulid();
    await prisma.remoteInstance.create({
      data: {
        id,
        host: `peer-${id}.example`,
        instanceKey: Buffer.alloc(32, 1),
        status: 'pending_outbound',
        capabilities: ['messages'],
      },
    });
    const found = await prisma.remoteInstance.findUnique({ where: { id } });
    expect(found?.host).toMatch(/peer-/);
  });

  it('persists a FederationKey row', async () => {
    const id = ulid();
    await prisma.federationKey.create({
      data: {
        id,
        isCurrent: true,
        publicKey: Buffer.alloc(32, 7),
        privateKey: Buffer.from('encrypted-blob'),
      },
    });
    const found = await prisma.federationKey.findUnique({ where: { id } });
    expect(found?.publicKey.length).toBe(32);
  });

  it('persists a FederationEnvelopeLog row tied to a peer', async () => {
    const peerId = ulid();
    await prisma.remoteInstance.create({
      data: {
        id: peerId,
        host: `peer-${peerId}.example`,
        instanceKey: Buffer.alloc(32, 2),
        status: 'pending_inbound',
        capabilities: [],
      },
    });
    const logId = ulid();
    await prisma.federationEnvelopeLog.create({
      data: {
        id: logId,
        direction: 'inbound',
        peerInstanceId: peerId,
        eventType: 'peering.request',
        payloadHash: Buffer.alloc(32, 9),
        nonce: ulid(),
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 60_000),
        status: 'accepted',
      },
    });
    const found = await prisma.federationEnvelopeLog.findUnique({ where: { id: logId } });
    expect(found?.eventType).toBe('peering.request');
  });
});
