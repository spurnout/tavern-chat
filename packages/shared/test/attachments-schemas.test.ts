import { describe, expect, it } from 'vitest';
import {
  attachmentKindSchema,
  attachmentSchema,
  attachmentStatusSchema,
  completeUploadRequestSchema,
  requestUploadRequestSchema,
  requestUploadResponseSchema,
} from '../src/schemas/attachments.js';

const ULID = '01HZX7Q4Y3K9V0G8WMC2P5N6BR';
const ULID2 = '01HZX7Q4Y3K9V0G8WMC2P5N6BS';
const NOW = '2026-01-01T00:00:00.000Z';

describe('attachmentKindSchema', () => {
  it.each([
    'image',
    'gif',
    'video',
    'audio',
    'voice_message',
    'map',
    'handout',
    'character_asset',
    'file',
  ])('accepts %s', (value) => {
    expect(attachmentKindSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(attachmentKindSchema.safeParse('sticker').success).toBe(false);
  });
});

describe('attachmentStatusSchema', () => {
  it.each([
    'pending',
    'uploaded',
    'processing',
    'ready',
    'failed',
    'blocked',
    'quarantined',
  ])('accepts %s', (value) => {
    expect(attachmentStatusSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(attachmentStatusSchema.safeParse('deleted').success).toBe(false);
  });
});

describe('attachmentSchema', () => {
  const valid = {
    id: ULID,
    uploaderId: ULID2,
    serverId: ULID,
    channelId: ULID2,
    messageId: ULID,
    kind: 'image',
    filename: 'pic.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    durationMs: null,
    waveform: null,
    thumbnailUrl: 'https://cdn.example.com/thumb.png',
    url: 'https://cdn.example.com/pic.png',
    status: 'ready',
    createdAt: NOW,
  };

  it('accepts a well-formed image attachment', () => {
    expect(attachmentSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts all nullable scope/dimension fields as null', () => {
    const result = attachmentSchema.safeParse({
      ...valid,
      serverId: null,
      channelId: null,
      messageId: null,
      width: null,
      height: null,
      durationMs: null,
      waveform: null,
      thumbnailUrl: null,
      url: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a voice message with a waveform array', () => {
    const result = attachmentSchema.safeParse({
      ...valid,
      kind: 'voice_message',
      durationMs: 3000,
      waveform: [0, 128, 255],
      width: null,
      height: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a waveform value above 255', () => {
    expect(attachmentSchema.safeParse({ ...valid, waveform: [256] }).success).toBe(false);
  });

  it('rejects a waveform value below 0', () => {
    expect(attachmentSchema.safeParse({ ...valid, waveform: [-1] }).success).toBe(false);
  });

  it('rejects a negative sizeBytes', () => {
    expect(attachmentSchema.safeParse({ ...valid, sizeBytes: -1 }).success).toBe(false);
  });

  it('accepts a zero sizeBytes (nonnegative)', () => {
    expect(attachmentSchema.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(true);
  });

  it('rejects a filename longer than 512 chars', () => {
    expect(attachmentSchema.safeParse({ ...valid, filename: 'a'.repeat(513) }).success).toBe(
      false,
    );
  });

  it('rejects a mimeType longer than 128 chars', () => {
    expect(attachmentSchema.safeParse({ ...valid, mimeType: 'a'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('rejects a non-URL thumbnailUrl', () => {
    expect(attachmentSchema.safeParse({ ...valid, thumbnailUrl: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid kind', () => {
    expect(attachmentSchema.safeParse({ ...valid, kind: 'nope' }).success).toBe(false);
  });
});

describe('requestUploadRequestSchema', () => {
  it('accepts a minimal request', () => {
    const result = requestUploadRequestSchema.safeParse({
      kind: 'file',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional serverId and channelId', () => {
    const result = requestUploadRequestSchema.safeParse({
      kind: 'image',
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 1,
      serverId: ULID,
      channelId: ULID2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects sizeBytes of 0 (must be positive)', () => {
    const result = requestUploadRequestSchema.safeParse({
      kind: 'file',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty filename', () => {
    const result = requestUploadRequestSchema.safeParse({
      kind: 'file',
      filename: '',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty mimeType', () => {
    const result = requestUploadRequestSchema.safeParse({
      kind: 'file',
      filename: 'doc.pdf',
      mimeType: '',
      sizeBytes: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing kind', () => {
    const result = requestUploadRequestSchema.safeParse({
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('requestUploadResponseSchema', () => {
  const attachment = {
    id: ULID,
    uploaderId: ULID2,
    serverId: null,
    channelId: null,
    messageId: null,
    kind: 'file',
    filename: 'doc.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    width: null,
    height: null,
    durationMs: null,
    waveform: null,
    thumbnailUrl: null,
    url: null,
    status: 'pending',
    createdAt: NOW,
  };

  it('accepts a well-formed response', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'PUT',
        url: 'https://s3.example.com/upload',
        headers: { 'content-type': 'application/pdf' },
        expiresAt: NOW,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty upload headers', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'PUT',
        url: 'https://s3.example.com/upload',
        headers: {},
        expiresAt: NOW,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts voice-aware throttled upload metadata', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'PUT',
        url: 'https://tavern.example.com/api/_governed-uploads/token',
        headers: { 'content-type': 'application/pdf' },
        expiresAt: NOW,
        strategy: 'tavern_throttled',
        voiceActive: true,
        maxBytesPerSecond: 262144,
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a method other than PUT', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'POST',
        url: 'https://s3.example.com/upload',
        headers: {},
        expiresAt: NOW,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL upload url', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'PUT',
        url: 'not-a-url',
        headers: {},
        expiresAt: NOW,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string header values', () => {
    const result = requestUploadResponseSchema.safeParse({
      attachment,
      upload: {
        method: 'PUT',
        url: 'https://s3.example.com/upload',
        headers: { 'content-length': 10 },
        expiresAt: NOW,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('completeUploadRequestSchema', () => {
  it('accepts a valid attachmentId', () => {
    expect(completeUploadRequestSchema.safeParse({ attachmentId: ULID }).success).toBe(true);
  });

  it('rejects a non-ULID attachmentId', () => {
    expect(completeUploadRequestSchema.safeParse({ attachmentId: 'nope' }).success).toBe(false);
  });

  it('rejects a missing attachmentId', () => {
    expect(completeUploadRequestSchema.safeParse({}).success).toBe(false);
  });
});
