/**
 * Local-storage HTTP routes.
 *
 * Only mounted when STORAGE_BACKEND=local.
 *
 *   PUT  /api/_local-uploads/:token   accept a presigned local upload
 *   GET  /api/_local-files/:bucket/:key   serve a stored object
 *
 * Authentication:
 *   PUT consumes a single-use token issued by `LocalStorageBackend.presignPut`.
 *       The browser hits this route directly with the file body — no auth
 *       header (mirroring the S3 presigned-PUT contract).
 *   GET serves files publicly within the dev/self-hosted threat model. The
 *       attachment metadata layer still enforces who can *see* a URL; the
 *       URL itself, once known, is fetchable without auth — same model as
 *       the S3 proxy in `attachments.ts` (URL secrecy + metadata gating).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LocalStorageBackend, type StorageBackend } from '@tavern/media';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
};

const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

const KEY_PATTERN = /^[A-Za-z0-9._\-/]+$/;
function isSafeKey(key: string): boolean {
  if (!KEY_PATTERN.test(key)) return false;
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

export interface LocalFileRouteDeps {
  storage: StorageBackend;
  uploadMaxBytes: number;
}

export async function registerLocalFileRoutes(
  app: FastifyInstance,
  deps: LocalFileRouteDeps,
): Promise<void> {
  const { storage, uploadMaxBytes } = deps;
  if (!(storage instanceof LocalStorageBackend)) return;
  const local = storage;

  // PUT: receive presigned local uploads. bodyLimit threaded through from
  // UPLOAD_MAX_BYTES (INF-017) so the local route, S3 presign, and worker
  // stat verification all agree on the same cap. nginx's client_max_body_size
  // must match in deployments that put nginx in front.
  app.route({
    method: 'PUT',
    url: '/api/_local-uploads/:token',
    bodyLimit: uploadMaxBytes,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => {
      const { token } = z.object({ token: z.string().min(8).max(96) }).parse(req.params);
      try {
        await local.acceptUpload(token, req.raw);
        reply.status(204).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        reply.status(400).send({ ok: false, error: { code: 'UPLOAD_BLOCKED', message } });
      }
    },
  });

  // GET: serve stored objects. Read-only; no listing.
  app.get<{
    Params: { bucket: string; key: string };
  }>('/api/_local-files/:bucket/:key', async (req, reply) => {
    const { bucket, key: rawKey } = req.params;

    // Quarantined objects (ClamAV-flagged uploads) must never be streamed to
    // clients. Hard 403 even if the storage key is known — mirrors the same
    // guard in apps/api/src/routes/attachments.ts for the S3 proxy.
    if (bucket === local.quarantineBucket) {
      reply.status(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Quarantined content is not retrievable' },
      });
      return;
    }
    if (bucket !== local.mainBucket) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    // Fastify already URL-decodes path params; don't double-decode.
    if (!isSafeKey(rawKey)) {
      reply.status(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Bad key' } });
      return;
    }
    const key = rawKey;

    const resolved = local.resolveSafe(bucket, key);
    if (!resolved) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    let info;
    try {
      info = await stat(resolved);
    } catch {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (!info.isFile()) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const mime = MIME_BY_EXT[extname(key).toLowerCase()] ?? 'application/octet-stream';
    const inline = INLINE_MIME_PREFIXES.some((p) => mime.startsWith(p));
    reply
      .type(mime)
      .header('content-length', String(info.size))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', inline ? 'inline' : `attachment; filename="${key.split('/').pop() ?? key}"`);

    const stream = createReadStream(resolved);
    stream.on('error', (err) => {
      req.log.warn({ err, bucket, key }, 'local-file stream error after headers');
      reply.raw.destroy(err instanceof Error ? err : new Error('stream error'));
    });
    return reply.send(stream);
  });
}
