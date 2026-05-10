/**
 * Queue factory.
 *
 *   In-memory mode (default, no REDIS_URL): scan jobs run in the API
 *     process via setImmediate. Single-replica only — fine for most
 *     self-hosted deployments and all of dev.
 *
 *   Redis-backed mode (REDIS_URL set): jobs go onto a BullMQ queue, the
 *     separate worker process consumes them. Required for multi-replica.
 *
 * The interface is the same either way — routes call `enqueueScan(id)`.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ClamAVScanner, runScanJob, type StorageBackend } from '@tavern/media';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@tavern/db';
import type { Config } from '../config.js';

// Both pino's Logger and Fastify's FastifyBaseLogger satisfy the small subset
// the pipeline uses. Accept either.
type AnyLogger = FastifyBaseLogger;

export interface QueueClient {
  enqueueScan(attachmentId: string): Promise<void>;
  close(): Promise<void>;
}

const SCAN_QUEUE_NAME = 'tavern.upload.scan';

export function createQueueClient(
  cfg: Config,
  deps: { storage: StorageBackend; scanner: ClamAVScanner | null; logger: AnyLogger },
): QueueClient {
  if (cfg.REDIS_URL) {
    return new RedisQueueClient(cfg.REDIS_URL, deps.logger);
  }
  return new InMemoryQueueClient({
    storage: deps.storage,
    scanner: deps.scanner,
    logger: deps.logger,
    allowUnscanned: cfg.ALLOW_UNSCANNED_UPLOADS,
  });
}

interface InMemoryDeps {
  storage: StorageBackend;
  scanner: ClamAVScanner | null;
  logger: AnyLogger;
  allowUnscanned: boolean;
}

class InMemoryQueueClient implements QueueClient {
  constructor(private readonly deps: InMemoryDeps) {}

  async enqueueScan(attachmentId: string): Promise<void> {
    // Run on a microtask so the HTTP response returns first.
    setImmediate(() => {
      runScanJob(
        { attachmentId },
        {
          storage: this.deps.storage,
          scanner: this.deps.scanner,
          // PrismaClient is stricter than the PrismaLike interface; cast at
          // the boundary, runtime behaviour is identical.
          prisma: prisma as unknown as Parameters<typeof runScanJob>[1]['prisma'],
          logger: this.deps.logger,
          allowUnscanned: this.deps.allowUnscanned,
        },
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err: message, attachmentId }, 'in-process scan job failed');
      });
    });
  }

  async close(): Promise<void> {
    /* nothing to clean up */
  }
}

class RedisQueueClient implements QueueClient {
  private connection: IORedis;
  private queue: Queue<{ attachmentId: string }>;

  constructor(redisUrl: string, _logger: AnyLogger) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<{ attachmentId: string }>(SCAN_QUEUE_NAME, {
      connection: this.connection,
    });
  }

  async enqueueScan(attachmentId: string): Promise<void> {
    await this.queue.add('scan', { attachmentId }, { jobId: `scan:${attachmentId}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.connection.disconnect();
  }
}
