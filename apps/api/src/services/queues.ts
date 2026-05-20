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
 * The interface is the same either way — routes call `enqueueScan(id)` or
 * `enqueueFederationOutbox(job)`.
 */

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ClamAVScanner, runScanJob, type StorageBackend } from '@tavern/media';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@tavern/db';
import {
  dispatchOutboxJob,
  FederationOutboxPermanentError,
  type FederationKeyStore,
  type FederationOutboxJob,
  type UserKeyStore,
} from '@tavern/federation';
import type { Config } from '../config.js';
import { gatewayBroker } from './gateway-broker.js';

// Both pino's Logger and Fastify's FastifyBaseLogger satisfy the small subset
// the pipeline uses. Accept either.
type AnyLogger = FastifyBaseLogger;

export interface QueueClient {
  enqueueScan(attachmentId: string): Promise<void>;
  /**
   * Enqueue a federation event for delivery to a single peer. In-memory mode
   * dispatches inline via setImmediate (fire-and-forget; failures are logged
   * but not retried — caller already committed the local message). Redis mode
   * pushes to BullMQ with retry + dead-letter behaviour, picked up by the
   * federation-outbox-worker in apps/worker.
   */
  enqueueFederationOutbox(job: FederationOutboxJob): Promise<void>;
  close(): Promise<void>;
}

const SCAN_QUEUE_NAME = 'tavern.upload.scan';
export const FEDERATION_OUTBOX_QUEUE_NAME = 'tavern.federation.outbox';

export interface FederationDispatcherSlot {
  keys: FederationKeyStore;
  userKeys: UserKeyStore;
  selfHost: string;
}

export function createQueueClient(
  cfg: Config,
  deps: {
    storage: StorageBackend;
    scanner: ClamAVScanner | null;
    logger: AnyLogger;
    /**
     * Lazily-resolved federation dispatcher dependencies. Optional — when the
     * api boots without FEDERATION_ENABLED, the slot is null and the outbox
     * enqueue path becomes a logged no-op. A getter lets app.ts populate it
     * AFTER QueueClient construction (the federation services are wired up
     * after the queue client in apps/api/src/app.ts).
     */
    getFederationDispatcher?: () => FederationDispatcherSlot | null;
  },
): QueueClient {
  if (cfg.REDIS_URL) {
    return new RedisQueueClient(cfg.REDIS_URL, deps.logger);
  }
  return new InMemoryQueueClient({
    storage: deps.storage,
    scanner: deps.scanner,
    logger: deps.logger,
    allowUnscanned: cfg.ALLOW_UNSCANNED_UPLOADS,
    getFederationDispatcher: deps.getFederationDispatcher,
  });
}

interface InMemoryDeps {
  storage: StorageBackend;
  scanner: ClamAVScanner | null;
  logger: AnyLogger;
  allowUnscanned: boolean;
  getFederationDispatcher?: () => FederationDispatcherSlot | null;
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
          // FE-17: notify the uploader's gateway connection that the
          // attachment is ready (or terminally failed). Single-replica mode:
          // we publish directly to the in-process broker, which the gateway
          // already subscribes to.
          onTerminalStatus: ({ attachmentId: id, uploaderId, status }) => {
            gatewayBroker.publish({
              type: 'ATTACHMENT_READY',
              userId: uploaderId,
              data: { attachmentId: id, status },
            });
          },
        },
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.error({ err: message, attachmentId }, 'in-process scan job failed');
      });
    });
  }

  async enqueueFederationOutbox(job: FederationOutboxJob): Promise<void> {
    const slot = this.deps.getFederationDispatcher?.() ?? null;
    if (!slot) {
      // Federation off (or wired up before bootstrap) — drop quietly. The
      // route layer shouldn't enqueue when FEDERATION_ENABLED=false, but
      // defence in depth: silently dropping is safer than crashing.
      this.deps.logger.warn(
        { peerInstanceId: job.peerInstanceId, eventType: job.eventType, messageId: job.messageId },
        'in-process outbox enqueue with no dispatcher configured — dropping',
      );
      return;
    }
    // Fire-and-forget. Single-replica mode has no retry — caller has already
    // committed the local message, a peer-side failure here is the same shape
    // of risk a worker process going OOM would produce. Log loudly so an
    // operator can spot persistent failures.
    setImmediate(() => {
      dispatchOutboxJob(job, {
        federationKeys: slot.keys,
        userKeys: slot.userKeys,
        selfHost: slot.selfHost,
        logger: this.deps.logger,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // Permanent vs retryable distinction is academic here — there is no
        // retry path. Distinguish in logs so the operator knows which.
        const isPermanent = err instanceof FederationOutboxPermanentError;
        this.deps.logger.error(
          {
            err: message,
            permanent: isPermanent,
            peerInstanceId: job.peerInstanceId,
            messageId: job.messageId,
            eventType: job.eventType,
          },
          'in-process federation outbox dispatch failed',
        );
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
  private outboxQueue: Queue<FederationOutboxJob>;
  private readonly logger: AnyLogger;

  constructor(redisUrl: string, logger: AnyLogger) {
    this.logger = logger;
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<{ attachmentId: string }>(SCAN_QUEUE_NAME, {
      connection: this.connection,
    });
    this.outboxQueue = new Queue<FederationOutboxJob>(FEDERATION_OUTBOX_QUEUE_NAME, {
      connection: this.connection,
    });
  }

  async enqueueScan(attachmentId: string): Promise<void> {
    await this.queue.add(
      'scan',
      { attachmentId },
      {
        jobId: `scan:${attachmentId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        // Keep a small ring of completed/failed jobs for observability,
        // not unbounded history.
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 200 },
      },
    );
  }

  async enqueueFederationOutbox(job: FederationOutboxJob): Promise<void> {
    // jobId guarantees idempotency — duplicate route hits for the same
    // (peer, event, message) collapse to a single job. nonce defaults to the
    // messageId, which is the right collapse key for the common case (one
    // message → one event per peer). Reaction/update events carry their own
    // nonces because the same message produces many events over time.
    const nonce = job.nonce ?? job.messageId;
    const jobId = `fedoutbox:${job.peerInstanceId}:${job.eventType}:${nonce}`;
    try {
      await this.outboxQueue.add('dispatch', job, {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1000 },
        // Retain failed jobs as the dead-letter window. The worker's
        // 'failed' handler logs structured fields so operators can find them.
        removeOnFail: { count: 1000 },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        { err: msg, peerInstanceId: job.peerInstanceId, messageId: job.messageId, eventType: job.eventType },
        'failed to enqueue federation outbox job',
      );
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.outboxQueue.close();
    this.connection.disconnect();
  }
}
