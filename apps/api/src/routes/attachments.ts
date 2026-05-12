/**
 * Attachment proxy route. Mounted when STORAGE_BACKEND=s3.
 *
 *   GET /api/_attachments/:bucket/:key   stream an object from S3
 *
 * Authentication model mirrors `/api/_local-files/`: the URL itself is
 * unauthenticated, but the storage key (a ULID derived from the attachment
 * row) is unguessable, and Tavern only serializes the URL into API responses
 * for users who can see the originating message/channel.
 *
 * Bonus: works against any S3-compatible backend (Garage, AWS, R2, B2, …)
 * without depending on bucket-level anonymous policies, which Garage v2.3
 * doesn't support on its S3 API endpoint.
 */

import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { S3StorageBackend, type StorageBackend } from '@tavern/media';

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

// Types that are safe to render inline. Everything else is sent as an
// attachment to prevent the browser from interpreting the response as HTML.
const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/'];

// Keys produced by the upload route look like
// `<userUlid>/<attachmentUlid>/<sanitizedFilename>` — letters, numbers, and
// `._-/` only. Reject everything else, including any `..` or empty segments,
// so a crafted URL can't reach the storage client with a different shape.
const KEY_PATTERN = /^[A-Za-z0-9._\-/]+$/;
function isSafeKey(key: string): boolean {
  if (!KEY_PATTERN.test(key)) return false;
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  storage: StorageBackend,
): Promise<void> {
  if (!(storage instanceof S3StorageBackend)) {
    app.log.info('attachments route skipped: storage backend is not s3');
    return;
  }

  app.get<{
    Params: { bucket: string; key: string };
  }>('/api/_attachments/:bucket/:key', async (req, reply) => {
    const { bucket, key: rawKey } = req.params;

    // Quarantined objects (potentially malicious uploads) must never be
    // streamed to clients. Hard 403 even if a key is somehow leaked.
    if (bucket === storage.quarantineBucket) {
      reply.status(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Quarantined content is not retrievable' },
      });
      return;
    }
    if (bucket !== storage.mainBucket) {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    // Fastify already URL-decodes path params; don't double-decode. Reject
    // any path-y characters that could let a crafted key reach the storage
    // client with a different shape than the upload code produced.
    if (!isSafeKey(rawKey)) {
      reply.status(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Bad key' } });
      return;
    }
    const key = rawKey;

    let stat;
    try {
      stat = await storage.statObject(bucket, key);
    } catch {
      reply.status(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
      return;
    }

    const mime = MIME_BY_EXT[extname(key).toLowerCase()] ?? 'application/octet-stream';
    const inline = INLINE_MIME_PREFIXES.some((p) => mime.startsWith(p));

    reply
      .type(mime)
      .header('content-length', String(stat.size))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      // STO-004: don't leak the storage-key path layout (which includes the
      // uploader ULID and the attachment ULID). Use just the final segment.
      .header(
        'content-disposition',
        inline ? 'inline' : `attachment; filename="${key.split('/').pop() ?? key}"`,
      );

    let stream: NodeJS.ReadableStream;
    try {
      stream = await storage.getObject(bucket, key);
    } catch (err) {
      // Race between statObject and getObject (e.g. concurrent delete) — emit
      // a 502 rather than letting Fastify surface an opaque 500.
      req.log.warn({ err, bucket, key }, 'attachment getObject failed after stat ok');
      reply.status(502).send({ ok: false, error: { code: 'BAD_GATEWAY', message: 'Upstream read failed' } });
      return;
    }

    // Handle late stream failures (S3 drops connection mid-transfer): once
    // headers are flushed we can only destroy the socket so the client sees
    // a truncated response rather than a silent 200.
    stream.on('error', (err) => {
      req.log.warn({ err, bucket, key }, 'attachment stream error after headers');
      reply.raw.destroy(err instanceof Error ? err : new Error('stream error'));
    });

    return reply.send(stream);
  });
}
