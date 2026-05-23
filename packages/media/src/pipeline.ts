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

/**
 * One element = ONE signature check (a sequence of bytes at a given offset).
 * A single MIME can require multiple checks via `signatures: [...]` in the
 * MIME table below — all must match for the MIME to be accepted. This is how
 * WEBP gets verified: the WEBP wrapper is RIFF (a generic Microsoft container
 * also used by AVI / WAV), so checking only `RIFF` at offset 0 is not
 * sufficient — we also require `WEBP` at offset 8.
 */
interface MagicSignature {
  sig: number[];
  offset?: number;
}

const MIME_MAGIC: Record<string, MagicSignature[][]> = {
  // Each outer entry is a set of (AND-ed) signatures that all must match.
  // Multiple outer entries are OR-ed. JPEG has several valid markers after
  // the SOI; we keep the conservative 3-byte prefix.
  'image/jpeg': [[{ sig: [0xff, 0xd8, 0xff] }]],
  'image/png': [[{ sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
  // WEBP = RIFF...WEBP. Both checks required (see comment above).
  'image/webp': [[{ sig: [0x52, 0x49, 0x46, 0x46] }, { sig: [0x57, 0x45, 0x42, 0x50], offset: 8 }]],
  'image/gif': [[{ sig: [0x47, 0x49, 0x46, 0x38] }]],
  'video/mp4': [[{ sig: [0x66, 0x74, 0x79, 0x70], offset: 4 }]],
  'video/webm': [[{ sig: [0x1a, 0x45, 0xdf, 0xa3] }]],
  'audio/mpeg': [[{ sig: [0x49, 0x44, 0x33] }]],
  'audio/ogg': [[{ sig: [0x4f, 0x67, 0x67, 0x53] }]],
};

function signatureMatches(buf: Buffer, sig: MagicSignature): boolean {
  const offset = sig.offset ?? 0;
  if (buf.length < offset + sig.sig.length) return false;
  for (let i = 0; i < sig.sig.length; i++) {
    if (buf[offset + i] !== sig.sig[i]) return false;
  }
  return true;
}

function checkMagic(buf: Buffer, declaredMime: string): boolean {
  const candidates = MIME_MAGIC[declaredMime];
  if (!candidates) {
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
  // Each candidate set is AND-ed; the candidates list is OR-ed.
  return candidates.some((sigSet) => sigSet.every((sig) => signatureMatches(buf, sig)));
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
    //
    // Previously this path buffered the entire object via `Buffer.concat`,
    // then re-decoded it THREE times (metadata, stripped, thumb). With the
    // 100 MiB upload cap and worker concurrency=4 that produced ~400 MiB
    // peak resident memory for a sustained image-job spike. We now:
    //   - pipe the storage stream into a single sharp instance,
    //   - `clone()` it for each output so the decoded representation is
    //     reused rather than re-decoded from the raw buffer,
    //   - never hold the raw bytes ourselves — sharp buffers internally
    //     only what it actually needs.
    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;
    if (IMAGE_KINDS.has(att.kind)) {
      const stream = await deps.storage.getObject(att.storageBucket, att.storageKey);
      const decoder = sharp({ animated: att.kind === 'gif' });
      // Best-effort error wiring so a decode error surfaces in the catch
      // block below rather than crashing the worker via unhandled 'error'.
      const readable = stream as NodeJS.ReadableStream;
      readable.on('error', (err) => decoder.destroy(err));
      readable.pipe(decoder);

      // Explicitly wait for the writable side of the decoder to finish
      // before kicking off the clones. sharp's `.metadata()` / `.toBuffer()`
      // resolve only after the writable finishes anyway, but on a slow
      // (network) input stream a misbehaving consumer could otherwise see
      // a partial-image metadata read or even a torn buffer. Making the
      // ordering explicit is cheap and removes that whole class of race.
      await new Promise<void>((resolve, reject) => {
        decoder.once('finish', resolve);
        decoder.once('error', reject);
      });

      const meta = await decoder.clone().metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;

      const stripped = await decoder.clone().rotate().toBuffer();
      await deps.storage.putObject(att.storageBucket, att.storageKey, stripped, att.mimeType);

      const thumb = await decoder
        .clone()
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
