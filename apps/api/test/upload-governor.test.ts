import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ObjectStat, StorageMode, UploadTicket } from '@tavern/media';
import { StorageBackend } from '@tavern/media';
import { prisma } from '@tavern/db';
import { loadConfig } from '../src/config.js';
import { registerGovernedUploadRoutes } from '../src/routes/governed-uploads.js';
import { UploadGovernor } from '../src/services/upload-governor.js';

vi.mock('@tavern/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

function makeConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    DATABASE_URL: 'postgresql://tavern:tavern-dev@localhost:5432/tavern-test',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3001',
    VOICE_ACTIVE_UPLOAD_THROTTLE_BYTES_PER_SECOND: String(1024 * 1024),
    VOICE_ACTIVE_UPLOAD_THROTTLE_BURST_BYTES: String(1024 * 1024),
    VOICE_ACTIVE_UPLOAD_THROTTLE_MAX_CONCURRENT: '1',
    ...overrides,
  });
}

class MemoryStorage extends StorageBackend {
  readonly mode: StorageMode = 'local';
  readonly mainBucket = 'media';
  readonly quarantineBucket = 'quarantine';
  readonly writes: Buffer[] = [];
  activeWrites = 0;
  maxActiveWrites = 0;

  async ensureBuckets(): Promise<void> {}

  async presignPut(): Promise<UploadTicket> {
    throw new Error('not used');
  }

  async getObject(): Promise<NodeJS.ReadableStream> {
    return Readable.from(Buffer.alloc(0));
  }

  async getPartialObject(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async putObject(_bucket: string, _key: string, body: Buffer): Promise<void> {
    this.writes.push(body);
  }

  async putObjectStream(
    _bucket: string,
    _key: string,
    body: Readable,
    _contentType: string,
    _sizeBytes: number,
  ): Promise<void> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      this.writes.push(Buffer.concat(chunks));
    } finally {
      this.activeWrites -= 1;
    }
  }

  async statObject(): Promise<ObjectStat> {
    return { size: 0, etag: 'etag' };
  }

  async copyObject(): Promise<void> {}

  async removeObject(): Promise<void> {}

  getPublicUrl(): string {
    return 'http://localhost/file';
  }

  bucketFor(): string {
    return this.mainBucket;
  }
}

describe('UploadGovernor', () => {
  it('detects active voice only when a room has at least two participants', async () => {
    const queryRaw = vi.mocked(prisma.$queryRaw);
    const governor = new UploadGovernor(makeConfig());
    try {
      queryRaw.mockResolvedValueOnce([]);
      await expect(governor.shouldThrottleUpload()).resolves.toBe(false);

      queryRaw.mockResolvedValueOnce([{ active: 1 }]);
      await expect(governor.shouldThrottleUpload()).resolves.toBe(true);

      const sql = String(queryRaw.mock.calls[0]?.[0] ?? '');
      expect(sql).toContain('HAVING COUNT(*) >= 2');
      expect(sql).toContain('LIMIT 1');
    } finally {
      governor.close();
    }
  });

  it('serializes governed uploads with the configured instance-wide concurrency', async () => {
    const governor = new UploadGovernor(makeConfig());
    const storage = new MemoryStorage();
    try {
      const first = governor.createGovernedTicket({
        bucket: storage.mainBucket,
        key: 'a.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 1,
      });
      const second = governor.createGovernedTicket({
        bucket: storage.mainBucket,
        key: 'b.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 1,
      });

      await Promise.all([
        governor.acceptGovernedUpload(tokenFrom(first.url), Readable.from(Buffer.from('a')), storage),
        governor.acceptGovernedUpload(tokenFrom(second.url), Readable.from(Buffer.from('b')), storage),
      ]);

      expect(storage.maxActiveWrites).toBe(1);
      expect(storage.writes).toEqual([Buffer.from('a'), Buffer.from('b')]);
    } finally {
      governor.close();
    }
  });

  it('rejects governed uploads that do not match the declared byte count', async () => {
    const governor = new UploadGovernor(makeConfig());
    const storage = new MemoryStorage();
    try {
      const ticket = governor.createGovernedTicket({
        bucket: storage.mainBucket,
        key: 'short.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 2,
      });

      await expect(
        governor.acceptGovernedUpload(tokenFrom(ticket.url), Readable.from(Buffer.from('a')), storage),
      ).rejects.toThrow('expected 2');
    } finally {
      governor.close();
    }
  });

  it('returns the configured throttle metadata for governed tickets', () => {
    const governor = new UploadGovernor(
      makeConfig({
        VOICE_ACTIVE_UPLOAD_THROTTLE_BYTES_PER_SECOND: '4096',
        VOICE_ACTIVE_UPLOAD_THROTTLE_BURST_BYTES: '8192',
      }),
    );
    try {
      const ticket = governor.createGovernedTicket({
        bucket: 'media',
        key: 'file.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 1,
      });

      expect(ticket.url).toBe('http://localhost:3001/api/_governed-uploads/' + tokenFrom(ticket.url));
      expect(ticket.strategy).toBe('tavern_throttled');
      expect(ticket.voiceActive).toBe(true);
      expect(ticket.maxBytesPerSecond).toBe(4096);
      expect(ticket.headers).toEqual({ 'content-type': 'application/octet-stream' });
    } finally {
      governor.close();
    }
  });

  it('accepts binary request bodies on the governed upload route', async () => {
    const governor = new UploadGovernor(makeConfig());
    const storage = new MemoryStorage();
    const app = Fastify();
    await registerGovernedUploadRoutes(app, {
      storage,
      uploadGovernor: governor,
      uploadMaxBytes: 1024,
    });
    try {
      const ticket = governor.createGovernedTicket({
        bucket: storage.mainBucket,
        key: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 4,
      });
      const res = await app.inject({
        method: 'PUT',
        url: new URL(ticket.url).pathname,
        headers: { 'content-type': 'image/png' },
        payload: Buffer.from([1, 2, 3, 4]),
      });

      expect(res.statusCode).toBe(204);
      expect(storage.writes).toEqual([Buffer.from([1, 2, 3, 4])]);
    } finally {
      await app.close();
      governor.close();
    }
  });
});

function tokenFrom(url: string): string {
  return new URL(url).pathname.split('/').pop() ?? '';
}
