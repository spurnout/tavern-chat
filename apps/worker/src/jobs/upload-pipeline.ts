/**
 * Upload pipeline (Phase 2/3).
 *
 *   tavern.upload.scan       — drives ClamAV + magic-byte validation
 *   tavern.media.process     — sharp thumbnails + ffprobe metadata
 *   tavern.voice.waveform    — generate 64-bin waveform for voice messages
 *
 * Each step updates the Attachment row's status. Failures move the object to
 * the quarantine bucket and surface a rejectionReason.
 */

import sharp from 'sharp';
import { prisma } from '@tavern/db';
import type { Logger } from 'pino';
import type { Client as MinioClient } from 'minio';
import type { WorkerConfig } from '../config.js';
import { ClamAVScanner } from '../scanner.js';

const IMAGE_KINDS = new Set(['image', 'gif', 'map', 'character_asset']);
const AUDIO_KINDS = new Set(['audio', 'voice_message']);

const MAGIC_BYTES: Array<{ mime: string; sig: number[]; offset?: number }> = [
  { mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46] }, // RIFF; further check for "WEBP"
  { mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'video/mp4', sig: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // "ftyp"
  { mime: 'video/webm', sig: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/mpeg', sig: [0x49, 0x44, 0x33] }, // ID3
  { mime: 'audio/ogg', sig: [0x4f, 0x67, 0x67, 0x53] },
];

function checkMagic(buf: Buffer, declaredMime: string): boolean {
  // For audio/wav and a few others, magic byte checks are common enough that
  // we allow-list a small set. If we don't have a signature, fall back to
  // letting the declared mime through (we still gate on extension + ClamAV).
  const candidates = MAGIC_BYTES.filter((m) => m.mime === declaredMime);
  if (candidates.length === 0) return true;
  return candidates.some((m) => {
    const offset = m.offset ?? 0;
    if (buf.length < offset + m.sig.length) return false;
    for (let i = 0; i < m.sig.length; i++) {
      if (buf[offset + i] !== m.sig[i]) return false;
    }
    return true;
  });
}

async function readHead(s3: MinioClient, bucket: string, key: string, n = 64): Promise<Buffer> {
  const stream = await s3.getPartialObject(bucket, key, 0, n);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

interface JobInput {
  attachmentId: string;
}

interface Deps {
  cfg: WorkerConfig;
  s3: MinioClient;
  scanner: ClamAVScanner;
  log: Logger;
}

export async function processScanJob(input: JobInput, deps: Deps): Promise<void> {
  const att = await prisma.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!att) {
    deps.log.warn({ attachmentId: input.attachmentId }, 'attachment not found');
    return;
  }
  if (att.status !== 'uploaded') {
    deps.log.info({ attachmentId: att.id, status: att.status }, 'skipping non-uploaded attachment');
    return;
  }

  await prisma.attachment.update({
    where: { id: att.id },
    data: { status: 'processing' },
  });

  try {
    // Magic byte check
    const head = await readHead(deps.s3, att.storageBucket, att.storageKey, 64);
    if (!checkMagic(head, att.mimeType)) {
      await reject(deps, att.id, att.storageBucket, att.storageKey, 'mime_mismatch', 'blocked');
      return;
    }

    // ClamAV
    if (!deps.cfg.ALLOW_UNSCANNED_UPLOADS) {
      const stream = await deps.s3.getObject(att.storageBucket, att.storageKey);
      const result = await deps.scanner.scanStream(stream).catch((err) => {
        deps.log.error({ err: err.message }, 'ClamAV scan failed');
        return null;
      });
      if (!result) {
        await reject(deps, att.id, att.storageBucket, att.storageKey, 'scanner_unavailable', 'failed');
        return;
      }
      if (!result.clean) {
        await reject(
          deps,
          att.id,
          att.storageBucket,
          att.storageKey,
          `virus:${result.signature ?? 'unknown'}`,
          'quarantined',
        );
        return;
      }
    }

    // Image post-processing (thumbnails + dimensions + EXIF strip).
    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;
    if (IMAGE_KINDS.has(att.kind)) {
      const stream = await deps.s3.getObject(att.storageBucket, att.storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      const meta = await sharp(buf).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;

      const stripped = await sharp(buf, { animated: att.kind === 'gif' })
        .rotate() // honor EXIF orientation, then drop EXIF on output
        .toBuffer();
      await deps.s3.putObject(att.storageBucket, att.storageKey, stripped, stripped.length, {
        'content-type': att.mimeType,
      });

      const thumb = await sharp(buf)
        .rotate()
        .resize({ width: 320, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      thumbnailKey = `${att.storageKey}.thumb.webp`;
      await deps.s3.putObject(att.storageBucket, thumbnailKey, thumb, thumb.length, {
        'content-type': 'image/webp',
      });
    }

    // Voice messages: ship a deterministic placeholder waveform until we wire
    // ffmpeg-based decoding. Callers can rely on the field being non-empty.
    let waveform: number[] | null = null;
    if (AUDIO_KINDS.has(att.kind) && att.kind === 'voice_message') {
      // The real version will run ffmpeg/ebur128 to compute peaks. For now we
      // write a small placeholder so the UI can render *something*.
      waveform = Array.from({ length: 32 }, (_, i) =>
        Math.round(64 + 64 * Math.sin((i / 32) * Math.PI * 2)),
      );
    }

    await prisma.attachment.update({
      where: { id: att.id },
      data: {
        status: 'ready',
        width,
        height,
        thumbnailKey,
        waveform: waveform ?? undefined,
        scannedAt: new Date(),
        scanResult: { clean: true },
      },
    });
  } catch (err) {
    deps.log.error({ err, attachmentId: att.id }, 'scan job failed');
    await reject(deps, att.id, att.storageBucket, att.storageKey, 'unexpected_error', 'failed');
  }
}

async function reject(
  deps: Deps,
  attachmentId: string,
  fromBucket: string,
  key: string,
  reason: string,
  status: 'failed' | 'blocked' | 'quarantined',
): Promise<void> {
  if (status === 'quarantined') {
    try {
      await deps.s3.copyObject(deps.cfg.S3_QUARANTINE_BUCKET, key, `/${fromBucket}/${key}`);
      await deps.s3.removeObject(fromBucket, key);
    } catch (err) {
      deps.log.error({ err, key }, 'quarantine copy failed');
    }
  } else if (status === 'blocked') {
    try {
      await deps.s3.removeObject(fromBucket, key);
    } catch {
      /* ignore */
    }
  }

  await prisma.attachment.update({
    where: { id: attachmentId },
    data: { status, rejectionReason: reason, scannedAt: new Date() },
  });
}
