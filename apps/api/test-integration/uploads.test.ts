/**
 * Integration tests for UPL-001 / STO-001 — quarantined-attachment isolation.
 * The route layer is covered by the existing fake-Prisma unit tests; here we
 * verify the Prisma model behaviour and the `serializeAttachment` policy
 * against a real database.
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

describe.skipIf(!dockerOk)('attachment serializer policy (UPL-001)', () => {
  it('serializeAttachment returns url=null for non-ready statuses', async () => {
    const uploaderId = ulid();
    await prisma.user.create({
      data: {
        id: uploaderId,
        username: 'up-1',
        usernameLower: 'up-1',
        displayName: 'Up',
        email: 'up-1@example.com',
        emailLower: 'up-1@example.com',
        passwordHash: 'x',
      },
    });
    const readyId = ulid();
    const pendingId = ulid();
    const quarantinedId = ulid();
    for (const [id, status] of [
      [readyId, 'ready'],
      [pendingId, 'pending'],
      [quarantinedId, 'quarantined'],
    ] as const) {
      await prisma.attachment.create({
        data: {
          id,
          uploaderId,
          kind: 'image',
          filename: 'photo.png',
          mimeType: 'image/png',
          sizeBytes: BigInt(1024),
          storageBucket: status === 'quarantined' ? 'tavern-quarantine' : 'tavern-media',
          storageKey: `${uploaderId}/${id}/photo.png`,
          status,
        },
      });
    }

    const { serializeAttachment } = await import('../src/lib/serializers.js');
    // Stub storage backend just for URL building.
    const storage = {
      getPublicUrl: (bucket: string, key: string) => `https://t/${bucket}/${key}`,
    } as unknown as Parameters<typeof serializeAttachment>[1];

    const ready = await prisma.attachment.findUniqueOrThrow({ where: { id: readyId } });
    const pending = await prisma.attachment.findUniqueOrThrow({ where: { id: pendingId } });
    const quarantined = await prisma.attachment.findUniqueOrThrow({ where: { id: quarantinedId } });

    expect(serializeAttachment(
      { ...ready, sizeBytes: BigInt(ready.sizeBytes), waveform: ready.waveform ?? [] } as Parameters<typeof serializeAttachment>[0],
      storage,
    ).url).not.toBeNull();
    expect(serializeAttachment(
      { ...pending, sizeBytes: BigInt(pending.sizeBytes), waveform: pending.waveform ?? [] } as Parameters<typeof serializeAttachment>[0],
      storage,
    ).url).toBeNull();
    expect(serializeAttachment(
      { ...quarantined, sizeBytes: BigInt(quarantined.sizeBytes), waveform: quarantined.waveform ?? [] } as Parameters<typeof serializeAttachment>[0],
      storage,
    ).url).toBeNull();
  });
});
