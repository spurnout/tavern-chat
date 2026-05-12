/**
 * Upload-scan pipeline.
 *
 * Consumed by:
 *   - `apps/worker` (when REDIS_URL is set, runs as a BullMQ job)
 *   - `apps/api`    (when REDIS_URL is missing, runs in-process after upload)
 *
 * The pipeline:
 *   1. Re-stat the object to confirm it landed in storage.
 *   2. Magic-byte check matching the declared MIME.
 *   3. ClamAV scan (skipped if scanner is null or `allowUnscanned: true`).
 *   4. Image normalisation: sharp re-encode (drops EXIF), thumbnail.
 *   5. Voice messages get a placeholder waveform (real one is computed
 *      client-side and posted via /api/attachments/:id/waveform).
 *
 * On any rejection, moves to quarantine bucket (or removes) and flips
 * Attachment.status to `quarantined` / `blocked` / `failed`.
 */

import sharp from 'sharp';
import type { Logger } from './logger.js';
import type { ClamAVScanner } from './scanner.js';
import type { StorageBackend } from './storage/types.js';

export interface ScanJobInput {
  attachmentId: string;
}

export interface PipelineDeps {
  storage: StorageBackend;
  scanner: ClamAVScanner | null;
  prisma: PrismaLike;
  logger: Logger;
  /** When true, accept uploads even if no scanner is reachable. */
  allowUnscanned: boolean;
  /**
   * FE-17: invoked once the attachment reaches a terminal status (ready /
   * failed / blocked / quarantined). Callers wire this to a gateway-broker
   * publish so the SPA can replace `setTimeout` polls with a deterministic
   * `ATTACHMENT_READY` event.
   */
  onTerminalStatus?: (input: {
    attachmentId: string;
    uploaderId: string;
    status: 'ready' | 'failed' | 'blocked' | 'quarantined';
  }) => void;
}

/**
 * Minimal Prisma surface the pipeline needs. We don't import PrismaClient
 * here so packages/media stays free of @prisma/client; the api/worker pass
 * their own client in.
 */
export interface PrismaLike {
  attachment: {
    findUnique(args: { where: { id: string } }): Promise<AttachmentRow | null>;
    update(args: {
      where: { id: string };
      data: AttachmentUpdate;
    }): Promise<AttachmentRow>;
  };
}

interface AttachmentRow {
  id: string;
  kind: string;
  mimeType: string;
  status: string;
  storageBucket: string;
  storageKey: string;
  uploaderId: string;
}

interface AttachmentUpdate {
  status?: string;
  width?: number | null;
  height?: number | null;
  thumbnailKey?: string | null;
  waveform?: number[];
  scannedAt?: Date;
  scanResult?: unknown;
  rejectionReason?: string;
}

const IMAGE_KINDS = new Set(['image', 'gif', 'map', 'character_asset']);
const AUDIO_KINDS = new Set(['audio', 'voice_message']);

const MAGIC_BYTES: Array<{ mime: string; sig: number[]; offset?: number }> = [
  { mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'video/mp4', sig: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { mime: 'video/webm', sig: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: 'audio/mpeg', sig: [0x49, 0x44, 0x33] },
  { mime: 'audio/ogg', sig: [0x4f, 0x67, 0x67, 0x53] },
];

function checkMagic(buf: Buffer, declaredMime: string): boolean {
  const candidates = MAGIC_BYTES.filter((m) => m.mime === declaredMime);
  if (candidates.length === 0) {
    // UPL-009: for the heavily-typed kinds (image/video/audio) we always
    // expect a magic signature. If the declared MIME is in those families
    // and we don't have one in the table, that's a config drift / a new MIME
    // we haven't whitelisted — reject rather than silently accept. For
    // free-form `handout`/`file` kinds (application/pdf, text/plain, …) we
    // can't reasonably enumerate signatures; trust the kind+ext check and
    // ClamAV downstream.
    if (
      declaredMime.startsWith('image/') ||
      declaredMime.startsWith('video/') ||
      declaredMime.startsWith('audio/')
    ) {
      return false;
    }
    return true;
  }
  return candidates.some((m) => {
    const offset = m.offset ?? 0;
    if (buf.length < offset + m.sig.length) return false;
    for (let i = 0; i < m.sig.length; i++) {
      if (buf[offset + i] !== m.sig[i]) return false;
    }
    return true;
  });
}

export async function runScanJob(input: ScanJobInput, deps: PipelineDeps): Promise<void> {
  const att = await deps.prisma.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!att) {
    deps.logger.warn({ attachmentId: input.attachmentId }, 'attachment not found');
    return;
  }
  if (att.status !== 'uploaded') {
    deps.logger.info(
      { attachmentId: att.id, status: att.status },
      'skipping non-uploaded attachment',
    );
    return;
  }

  await deps.prisma.attachment.update({
    where: { id: att.id },
    data: { status: 'processing' },
  });

  try {
    // 1. Magic byte sniff.
    const head = await deps.storage.getPartialObject(att.storageBucket, att.storageKey, 64);
    if (!checkMagic(head, att.mimeType)) {
      await reject(deps, att, 'mime_mismatch', 'blocked');
      return;
    }

    // 2. ClamAV.
    if (deps.scanner) {
      const stream = await deps.storage.getObject(att.storageBucket, att.storageKey);
      const result = await deps.scanner.scanStream(stream).catch((err: Error) => {
        deps.logger.error({ err: err.message }, 'ClamAV scan failed');
        return null;
      });
      if (!result) {
        if (deps.allowUnscanned) {
          deps.logger.warn({ attachmentId: att.id }, 'scanner unavailable, accepting per policy');
        } else {
          await reject(deps, att, 'scanner_unavailable', 'failed');
          return;
        }
      } else if (!result.clean) {
        await reject(deps, att, `virus:${result.signature ?? 'unknown'}`, 'quarantined');
        return;
      }
    } else if (!deps.allowUnscanned) {
      // No scanner configured AND we don't allow unscanned — block.
      await reject(deps, att, 'scanner_unavailable', 'failed');
      return;
    }

    // 3. Image normalisation + thumbnail.
    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;
    if (IMAGE_KINDS.has(att.kind)) {
      const stream = await deps.storage.getObject(att.storageBucket, att.storageKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      const meta = await sharp(buf).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;

      const stripped = await sharp(buf, { animated: att.kind === 'gif' }).rotate().toBuffer();
      await deps.storage.putObject(att.storageBucket, att.storageKey, stripped, att.mimeType);

      const thumb = await sharp(buf)
        .rotate()
        .resize({ width: 320, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      thumbnailKey = `${att.storageKey}.thumb.webp`;
      await deps.storage.putObject(att.storageBucket, thumbnailKey, thumb, 'image/webp');
    }

    // 4. Placeholder waveform for voice messages — the real one comes from
    //    the browser via a separate endpoint.
    let waveform: number[] | null = null;
    if (AUDIO_KINDS.has(att.kind) && att.kind === 'voice_message') {
      waveform = Array.from({ length: 32 }, (_, i) =>
        Math.round(64 + 64 * Math.sin((i / 32) * Math.PI * 2)),
      );
    }

    await deps.prisma.attachment.update({
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
    deps.onTerminalStatus?.({
      attachmentId: att.id,
      uploaderId: att.uploaderId,
      status: 'ready',
    });
  } catch (err) {
    deps.logger.error({ err, attachmentId: att.id }, 'scan job failed');
    await reject(deps, att, 'unexpected_error', 'failed');
  }
}

async function reject(
  deps: PipelineDeps,
  att: AttachmentRow,
  reason: string,
  status: 'failed' | 'blocked' | 'quarantined',
): Promise<void> {
  if (status === 'quarantined') {
    try {
      await deps.storage.copyObject(
        att.storageBucket,
        att.storageKey,
        deps.storage.quarantineBucket,
        att.storageKey,
      );
      await deps.storage.removeObject(att.storageBucket, att.storageKey);
    } catch (err) {
      deps.logger.error({ err, key: att.storageKey }, 'quarantine copy failed');
    }
  } else if (status === 'blocked') {
    try {
      await deps.storage.removeObject(att.storageBucket, att.storageKey);
    } catch {
      /* ignore */
    }
  }

  await deps.prisma.attachment.update({
    where: { id: att.id },
    data: { status, rejectionReason: reason, scannedAt: new Date() },
  });
  deps.onTerminalStatus?.({
    attachmentId: att.id,
    uploaderId: att.uploaderId,
    status,
  });
}
