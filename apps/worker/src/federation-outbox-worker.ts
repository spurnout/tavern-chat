/**
 * P3-5: Federation outbox worker.
 *
 * Consumes jobs from the `tavern.federation.outbox` BullMQ queue and dispatches
 * each one to its target peer via dispatchOutboxJob (from @tavern/federation).
 *
 * Retry policy is set by the enqueue side (apps/api/src/services/queues.ts):
 *   - attempts: 3
 *   - backoff: exponential, base 5s
 *   - removeOnFail: 1000 — the failed-job ring IS the dead-letter list. The
 *     'failed' handler below logs at error level when a job exhausts attempts
 *     so operators see them in their log pipeline.
 *
 * 4xx responses are treated as permanent failures: the dispatcher throws
 * FederationOutboxPermanentError, and this worker turns those into immediate
 * fail-without-retry by setting attemptsMade=attempts before re-throwing.
 * Anything else (5xx, network, timeout) is a plain Error → BullMQ retries it.
 */

import type { Processor, Worker } from 'bullmq';
import { Worker as BullWorker } from 'bullmq';
import type { Logger } from 'pino';
import type IORedis from 'ioredis';
import {
  FederationKeyStore,
  FederationOutboxPermanentError,
  UserKeyStore,
  dispatchOutboxJob,
  type FederationOutboxJob,
} from '@tavern/federation';
import type { WorkerConfig } from './config.js';

export const FEDERATION_OUTBOX_QUEUE = 'tavern.federation.outbox';
const CONCURRENCY = 4;

export interface FederationOutboxWorkerDeps {
  connection: IORedis;
  cfg: WorkerConfig;
  logger: Logger;
  /** Optional gateway publisher so the worker can push user-targeted events. */
  gatewayPublisher?: IORedis;
}

export interface FederationOutboxWorkerHandle {
  worker: Worker<FederationOutboxJob>;
  close: () => Promise<void>;
}

/**
 * Bootstrap the outbox worker. Returns null when federation is off — the
 * caller (apps/worker/src/index.ts) treats null as "skip" rather than
 * silently no-oping inside the worker, so the operator sees one decisive
 * "federation outbox: not configured" log line on startup.
 */
export async function startFederationOutboxWorker(
  deps: FederationOutboxWorkerDeps,
): Promise<FederationOutboxWorkerHandle | null> {
  const { cfg, logger, connection, gatewayPublisher } = deps;
  if (!cfg.FEDERATION_ENABLED) {
    logger.info('federation outbox: FEDERATION_ENABLED=false, skipping worker');
    return null;
  }
  if (!cfg.TAVERN_DATA_KEY) {
    logger.warn(
      'federation outbox: FEDERATION_ENABLED=true but TAVERN_DATA_KEY missing; skipping worker',
    );
    return null;
  }

  const dataKey = decodeDataKey(cfg.TAVERN_DATA_KEY);

  const federationKeys = new FederationKeyStore({ dataKey });
  await federationKeys.bootstrap();
  const userKeys = new UserKeyStore({ dataKey });

  const selfHost = new URL(cfg.PUBLIC_BASE_URL).host;

  const processor: Processor<FederationOutboxJob> = async (job) => {
    const data = job.data;
    logger.info(
      {
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        peerInstanceId: data.peerInstanceId,
        eventType: data.eventType,
        messageId: data.messageId,
      },
      'outbox: processing',
    );
    try {
      await dispatchOutboxJob(data, {
        federationKeys,
        userKeys,
        selfHost,
        // Pino's Logger satisfies the small interface dispatchOutboxJob expects.
        logger,
      });
    } catch (err) {
      if (err instanceof FederationOutboxPermanentError) {
        // BullMQ doesn't have a built-in "fail permanently" affordance; the
        // canonical approach is to throw an UnrecoverableError. We rebrand
        // the permanent error onto a fresh Error with that class name so
        // BullMQ's matcher picks it up. (Importing BullMQ's
        // `UnrecoverableError` directly works too — the name-based fallback
        // here just keeps us decoupled.)
        const stop = new Error(err.message);
        stop.name = 'UnrecoverableError';
        throw stop;
      }
      throw err;
    }
  };

  const worker = new BullWorker<FederationOutboxJob>(FEDERATION_OUTBOX_QUEUE, processor, {
    connection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      logger.error({ err: err.message }, 'outbox: job failed (no job object)');
      return;
    }
    // `?? 0` previously made every failure look exhausted (0 >= 0), which
    // spuriously emitted DM_CHANNEL_FEDERATION_REFUSED on the first transient
    // failure. Treat a missing attempts cap as "no cap" so only an actual
    // BullMQ-driven retry exhaustion qualifies, plus the explicit
    // `UnrecoverableError` path BullMQ raises for permanent failures.
    const maxAttempts = job.opts.attempts ?? Infinity;
    const exhausted =
      job.attemptsMade >= maxAttempts || err.name === 'UnrecoverableError';
    const level = exhausted ? 'error' : 'warn';
    logger[level](
      {
        jobId: job.id,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        peerInstanceId: job.data.peerInstanceId,
        eventType: job.data.eventType,
        messageId: job.data.messageId,
        err: err.message,
        deadLettered: exhausted,
      },
      exhausted ? 'outbox: job dead-lettered after exhausting attempts' : 'outbox: job failed; will retry',
    );
    // FO-3: when a dm.create job exhausts all retries, notify the initiating
    // user so their DMs view can surface a banner. `job.data.messageId` IS
    // the dmChannelId (set by the enqueue side in services/queues.ts).
    if (exhausted && job.data.eventType === 'dm.create' && gatewayPublisher) {
      void gatewayPublisher
        .publish(
          'tavern:gateway',
          JSON.stringify({
            type: 'DM_CHANNEL_FEDERATION_REFUSED',
            userId: job.data.authorUserId,
            data: {
              dmChannelId: job.data.messageId,
              reason: 'permanent_error',
            },
          }),
        )
        .catch((publishErr) => {
          logger.warn({ publishErr }, 'failed to notify user of DM federation refused');
        });
    }
  });

  worker.on('completed', (job) => {
    logger.info(
      {
        jobId: job.id,
        peerInstanceId: job.data.peerInstanceId,
        eventType: job.data.eventType,
        messageId: job.data.messageId,
      },
      'outbox: completed',
    );
  });

  logger.info(
    { queue: FEDERATION_OUTBOX_QUEUE, concurrency: CONCURRENCY, selfHost },
    'federation outbox worker ready',
  );

  return {
    worker,
    close: async () => {
      await worker.close();
    },
  };
}

function decodeDataKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) {
    throw new Error(
      `TAVERN_DATA_KEY: must decode to exactly 32 bytes (got ${decoded.length})`,
    );
  }
  // Round-trip check catches invalid base64 chars that Buffer would silently drop.
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('TAVERN_DATA_KEY: invalid base64 (round-trip mismatch)');
  }
  return decoded;
}
