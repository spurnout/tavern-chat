import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageBackend } from '@tavern/media';
import { registerLocalFileRoutes } from '../src/routes/local-files.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function buildLocalApp() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tavern-local-files-'));
  const storage = new LocalStorageBackend({
    dataDir,
    mainBucket: 'media',
    quarantineBucket: 'quarantine',
    apiBaseUrl: 'http://localhost:3001',
  });
  const app = Fastify();
  await registerLocalFileRoutes(app, { storage, uploadMaxBytes: 1024 });
  cleanups.push(async () => {
    await app.close();
    storage.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, storage };
}

describe('PUT /api/_local-uploads/:token', () => {
  it('accepts a presigned upload and writes the object', async () => {
    const { app, storage } = await buildLocalApp();
    const ticket = await storage.presignPut('media', 'user/att/file.bin', 'image/png', 4);
    const token = new URL(ticket.url).pathname.split('/').pop() ?? '';

    const res = await app.inject({
      method: 'PUT',
      url: `/api/_local-uploads/${token}`,
      headers: ticket.headers,
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(res.statusCode).toBe(204);
    const stat = await storage.statObject('media', 'user/att/file.bin');
    expect(stat.size).toBe(4);
  });

  it('400s with the rejection message for an unknown token', async () => {
    const { app } = await buildLocalApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/_local-uploads/${'a'.repeat(32)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.error.code).toBe('UPLOAD_BLOCKED');
    expect(body.error.message).toBe('Unknown upload token');
  });

  it('400s when the body overflows the declared size, without leaking paths', async () => {
    const { app, storage } = await buildLocalApp();
    const ticket = await storage.presignPut('media', 'user/att/file.bin', 'image/png', 2);
    const token = new URL(ticket.url).pathname.split('/').pop() ?? '';

    const res = await app.inject({
      method: 'PUT',
      url: `/api/_local-uploads/${token}`,
      headers: ticket.headers,
      payload: Buffer.from('toolong'),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.error.code).toBe('UPLOAD_BLOCKED');
    expect(body.error.message).toBe('Upload exceeds declared size (2 bytes)');
    expect(body.error.message).not.toContain(tmpdir());
  });
});
