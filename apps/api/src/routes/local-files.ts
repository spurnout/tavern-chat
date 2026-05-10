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
 *       URL itself, once known, is fetchable without auth — same as MinIO's
 *       `mc anonymous set download` config in the docker stack.
 */

import { createReadStream, statSync } from 'node:fs';
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

export async function registerLocalFileRoutes(
  app: FastifyInstance,
  storage: StorageBackend,
): Promise<void> {
  if (!(storage instanceof LocalStorageBackend)) return;
  const local = storage;

  // PUT: receive presigned local uploads.
  // Larger than the default Fastify body limit — uploads can be hundreds of MB.
  app.route({
    method: 'PUT',
    url: '/api/_local-uploads/:token',
    bodyLimit: 256 * 1024 * 1024,
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
    const { bucket } = req.params;
    const key = decodeURIComponent(req.params.key);
    const resolved = local.resolveSafe(bucket, key);
    if (!resolved) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }
    if (!stat.isFile()) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const mime = MIME_BY_EXT[extname(key).toLowerCase()] ?? 'application/octet-stream';
    reply
      .type(mime)
      .header('content-length', String(stat.size))
      .header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(createReadStream(resolved));
  });
}
