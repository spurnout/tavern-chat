/**
 * Deterministic upload validation.
 *
 * We validate three things, in this order:
 *   1. Filename extension is not on the blocklist.
 *   2. Content-Type matches the kind the user requested AND is allowlisted
 *      for that kind. We do NOT trust user-supplied MIME types blindly; the
 *      worker re-checks magic bytes after upload.
 *   3. Size is within the per-kind limit.
 *
 * SVG is rejected outright — it can carry script content and is too risky to
 * render inline.
 */

import {
  ALLOWED_AUDIO_MIMES,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  BLOCKED_ARCHIVE_EXTENSIONS,
  BLOCKED_EXTENSIONS,
  ErrorCodes,
  TavernError,
  UPLOAD_LIMITS,
  type AttachmentKind,
} from '@tavern/shared';
import type { Config } from '../config.js';

export interface UploadInput {
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export class UploadValidator {
  constructor(private readonly cfg: Config) {}

  validate(input: UploadInput): void {
    const ext = extensionOf(input.filename);
    if (ext === 'svg' || input.mimeType === 'image/svg+xml') {
      throw new TavernError(ErrorCodes.UPLOAD_BLOCKED, 'SVG uploads are not allowed', 415);
    }
    if (this.cfg.BLOCK_EXECUTABLE_UPLOADS && BLOCKED_EXTENSIONS.includes(ext as never)) {
      throw new TavernError(
        ErrorCodes.UPLOAD_BLOCKED,
        'Executable uploads are not allowed on this instance',
        415,
      );
    }
    if (this.cfg.BLOCK_ARCHIVE_UPLOADS && BLOCKED_ARCHIVE_EXTENSIONS.includes(ext as never)) {
      throw new TavernError(
        ErrorCodes.UPLOAD_BLOCKED,
        'Archive uploads are not allowed on this instance',
        415,
      );
    }

    switch (input.kind) {
      case 'image':
      case 'gif':
      case 'map':
      case 'character_asset':
        if (!ALLOWED_IMAGE_MIMES.includes(input.mimeType as never)) {
          throw new TavernError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 'Image type not allowed', 415);
        }
        if (input.sizeBytes > UPLOAD_LIMITS.MAX_IMAGE_BYTES) {
          throw new TavernError(ErrorCodes.PAYLOAD_TOO_LARGE, 'Image too large', 413);
        }
        return;
      case 'video':
        if (!ALLOWED_VIDEO_MIMES.includes(input.mimeType as never)) {
          throw new TavernError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 'Video type not allowed', 415);
        }
        if (input.sizeBytes > UPLOAD_LIMITS.MAX_VIDEO_BYTES) {
          throw new TavernError(ErrorCodes.PAYLOAD_TOO_LARGE, 'Video too large', 413);
        }
        return;
      case 'audio':
      case 'voice_message':
        if (!ALLOWED_AUDIO_MIMES.includes(input.mimeType as never)) {
          throw new TavernError(ErrorCodes.UNSUPPORTED_MEDIA_TYPE, 'Audio type not allowed', 415);
        }
        if (input.sizeBytes > UPLOAD_LIMITS.MAX_AUDIO_BYTES) {
          throw new TavernError(ErrorCodes.PAYLOAD_TOO_LARGE, 'Audio too large', 413);
        }
        return;
      case 'handout':
      case 'file':
        if (input.sizeBytes > UPLOAD_LIMITS.MAX_GENERIC_FILE_BYTES) {
          throw new TavernError(ErrorCodes.PAYLOAD_TOO_LARGE, 'File too large', 413);
        }
        return;
      default:
        throw new TavernError(ErrorCodes.VALIDATION_ERROR, 'Unknown attachment kind', 400);
    }
  }
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return '';
  return filename.slice(idx + 1).toLowerCase();
}
