// Side-effect import — must come first so .env populates process.env.
import './load-env.js';

import pino from 'pino';
import path from 'node:path';
import { Queue, Worker, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import {
  ClamAVScanner,
  LocalStorageBackend,
  S3StorageBackend,
  runScanJob,
  type StorageBackend,
} from '@tavern/media';
import { prisma } from '@tavern/db';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { startFederationOutboxWorker } from './federation-outbox-worker.js';

const SCAN_QUEUE = 'tavern.upload.scan';
const MAINTENANCE_QUEUE = 'tavern.maintenance';
type MaintenanceJob =
  | { kind: 'audit-retention'; retentionDays: number }
  | { kind: 'nonce-cleanup'; retentionHours: number }
  | { kind: 'expired-custom-status' }
  | { kind: 'federation-envelope-retention'; retentionDays: number };

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const log = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport:
      cfg.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
  });

  if (!cfg.REDIS_URL) {
    // INF-006: when running under `restart: unless-stopped` (the previous
    // default), a clean process exit caused a restart loop because the
    // container kept being told "stay up". The worker has nothing to do
    // without Redis but it must still not exit; idle until SIGTERM/SIGINT.
    log.info(
      'REDIS_URL is not set. In-process mode: the api runs the upload ' +
        'pipeline directly. Idling until the process is signalled.',
    );
    const idleSignals = (sig: string) => {
      log.info({ signal: sig }, 'worker idle -> shutdown');
      process.exit(0);
    };
    process.on('SIGTERM', () => idleSignals('SIGTERM'));
    process.on('SIGINT', () => idleSignals('SIGINT'));
    await new Promise<void>(() => {
      /* never resolves; keeps the event loop alive */
    });
    return;
  }

  // SEC: log only the host:port — REDIS_URL may carry credentials
  // (redis://:password@host:port) and log aggregators retain them indefinitely.
  log.info({ redis: redactRedisUrl(cfg.REDIS_URL) }, 'tavern worker starting');

  const storage = createStorage(cfg);
  const scanner = cfg.CLAMAV_HOST
    ? new ClamAVScanner({ host: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT })
    : null;

  const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

  // FE-17: a second Redis publisher so the worker can fan an
  // ATTACHMENT_READY event into the same `tavern:gateway` channel the api
  // process is already subscribed to. Going through Redis (rather than
  // requiring the api process to poll DB) is the multi-replica equivalent
  // of the in-process broker callback used in single-replica mode.
  const gatewayPublisher = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  const GATEWAY_CHANNEL = 'tavern:gateway';

  const processor: Processor<{ attachmentId: string }> = async (job) => {
    log.info({ jobId: job.id, attachmentId: job.data.attachmentId }, 'scan job received');
    await runScanJob(job.data, {
      storage,
      scanner,
      // PrismaClient is stricter than the PrismaLike interface (e.g. its
      // JsonValue input type). Cast at the boundary; runtime behaviour is
      // identical.
      prisma: prisma as unknown as Parameters<typeof runScanJob>[1]['prisma'],
      logger: log,
      allowUnscanned: cfg.ALLOW_UNSCANNED_UPLOADS,
      onTerminalStatus: ({ attachmentId, uploaderId, status }) => {
        void gatewayPublisher
          .publish(
            GATEWAY_CHANNEL,
            JSON.stringify({
              type: 'ATTACHMENT_READY',
              userId: uploaderId,
              data: { attachmentId, status },
            }),
          )
          .catch((err: unknown) => {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'gateway publish failed');
          });
      },
    });
  };

  const worker = new Worker<{ attachmentId: string }>(SCAN_QUEUE, processor, {
    connection,
    concurrency: 4,
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'job failed');
  });

  // Scheduled maintenance: audit-log retention (DB-009) and message-nonce
  // cleanup (DB-010). BullMQ repeatable jobs run on a cron-style cadence and
  // are idempotent — re-registering with the same key just refreshes them.
  const maintenanceQueue = new Queue<MaintenanceJob>(MAINTENANCE_QUEUE, { connection });
  const maintenanceProcessor: Processor<MaintenanceJob> = async (job) => {
    if (job.data.kind === 'audit-retention') {
      const cutoff = new Date(Date.now() - job.data.retentionDays * 86_400_000);
      // BATCH: a single unbounded DELETE on a multi-million-row table holds
      // row-level locks for the full duration and amplifies WAL pressure,
      // stalling concurrent writes (audit-log inserts, federation envelope
      // inserts) for seconds. Chunk to 5_000 rows per pass and yield between
      // passes so the worker doesn't monopolise the connection either.
      const deleted = await pruneInBatches('auditLogEntry', { createdAt: { lt: cutoff } });
      log.info({ deleted, retentionDays: job.data.retentionDays }, 'audit retention sweep');
    } else if (job.data.kind === 'nonce-cleanup') {
      const cutoff = new Date(Date.now() - job.data.retentionHours * 3_600_000);
      const result = await prisma.message.updateMany({
        where: { nonce: { not: null }, createdAt: { lt: cutoff } },
        data: { nonce: null },
      });
      log.info({ cleared: result.count, retentionHours: job.data.retentionHours }, 'nonce cleanup sweep');
    } else if (job.data.kind === 'expired-custom-status') {
      // Find every user whose custom-status expiry has passed, then clear
      // both the status and the timestamp. We need the affected userIds
      // and their shared servers to fan out MEMBER_UPDATE so open profile
      // cards refresh — Prisma's updateMany doesn't return rows, so we
      // query first. Single query with a relation include avoids an N+1
      // (was one `serverMember.findMany` per expired user).
      const now = new Date();
      const expired = await prisma.user.findMany({
        where: { customStatusExpiresAt: { lte: now, not: null } },
        select: { id: true, memberships: { select: { serverId: true } } },
      });
      if (expired.length === 0) return;
      await prisma.user.updateMany({
        where: { id: { in: expired.map((u) => u.id) } },
        data: { customStatus: null, customStatusExpiresAt: null },
      });
      for (const { id: userId, memberships } of expired) {
        for (const { serverId } of memberships) {
          void gatewayPublisher
            .publish(
              GATEWAY_CHANNEL,
              JSON.stringify({
                type: 'MEMBER_UPDATE',
                serverId,
                data: {
                  serverId,
                  userId,
                  user: { id: userId, customStatus: null, customStatusExpiresAt: null },
                },
              }),
            )
            .catch((err: unknown) => {
              log.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'gateway publish failed (expired-custom-status)',
              );
            });
        }
      }
      log.info({ cleared: expired.length }, 'expired custom-status sweep');
    } else if (job.data.kind === 'federation-envelope-retention') {
      const cutoff = new Date(Date.now() - job.data.retentionDays * 86_400_000);
      // BATCH: same reasoning as audit-retention — a peered instance whose
      // peer was offline for an extended period can accumulate millions of
      // log rows. Chunked deletes keep each transaction short.
      const count = await pruneInBatches('federationEnvelopeLog', { receivedAt: { lt: cutoff } });
      log.info({ count, cutoffDate: cutoff }, 'federation-envelope-retention: pruned rows');
    }
  };

  // Chunked-delete helper. Prisma's deleteMany has no LIMIT, and unbounded
  // DELETEs on retention tables hold row-level locks for the full duration.
  // Yields between batches so other workers can make progress.
  async function pruneInBatches(
    table: 'auditLogEntry' | 'federationEnvelopeLog',
    where: Record<string, unknown>,
    batchSize = 5_000,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      // The two supported tables both have `id: string` PKs; the cast keeps
      // the helper polymorphic without giving up Prisma's generated types
      // at the call site.
      const ids = await (prisma[table] as unknown as {
        findMany(args: {
          where: Record<string, unknown>;
          select: { id: true };
          take: number;
        }): Promise<{ id: string }[]>;
      }).findMany({ where, select: { id: true }, take: batchSize });
      if (ids.length === 0) break;
      const result = await (prisma[table] as unknown as {
        deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
      }).deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      total += result.count;
      if (ids.length < batchSize) break;
      // Yield to the event loop so concurrent jobs and the BullMQ heartbeat
      // don't starve. setImmediate is enough — we don't need a real delay.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return total;
  }
  const maintenanceWorker = new Worker<MaintenanceJob>(MAINTENANCE_QUEUE, maintenanceProcessor, {
    connection,
    concurrency: 1,
  });
  maintenanceWorker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, kind: job?.data.kind, err: err.message }, 'maintenance job failed');
  });

  // P3-5: federation outbox consumer — only spins up when FEDERATION_ENABLED.
  // FO-3: pass gatewayPublisher so the worker can notify the initiating user
  // when a dm.create job exhausts all retries.
  const federationOutboxHandle = await startFederationOutboxWorker({
    connection,
    cfg,
    logger: log,
    gatewayPublisher,
  });

  // Daily at 03:00 UTC for both. The retention sweep is the heavier of the
  // two; staggering would matter if there were more jobs, but for two cheap
  // queries it doesn't.
  await maintenanceQueue.add(
    'audit-retention',
    { kind: 'audit-retention', retentionDays: cfg.AUDIT_RETENTION_DAYS },
    { repeat: { pattern: '0 3 * * *' }, removeOnComplete: true, removeOnFail: { count: 10 }, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, jobId: 'audit-retention' },
  );
  await maintenanceQueue.add(
    'nonce-cleanup',
    { kind: 'nonce-cleanup', retentionHours: cfg.NONCE_RETENTION_HOURS },
    { repeat: { pattern: '15 * * * *' }, removeOnComplete: true, removeOnFail: { count: 10 }, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, jobId: 'nonce-cleanup' },
  );
  // Track 3 — clear expired custom statuses every 5 minutes. Cheaper than
  // a per-row deadline since most users never set an expiry, and the
  // worst-case latency (status shows for ~5 minutes past expiry) is fine.
  await maintenanceQueue.add(
    'expired-custom-status',
    { kind: 'expired-custom-status' },
    {
      repeat: { pattern: '*/5 * * * *' },
      removeOnComplete: true,
      removeOnFail: { count: 10 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      jobId: 'expired-custom-status',
    },
  );
  // FO-1: prune FederationEnvelopeLog rows older than 30 days daily at 03:30
  // UTC. Keeps the replay-window table lean; rows beyond the window are
  // useless for replay detection.
  await maintenanceQueue.add(
    'federation-envelope-retention',
    { kind: 'federation-envelope-retention', retentionDays: 30 },
    {
      repeat: { pattern: '30 3 * * *' },
      removeOnComplete: true,
      removeOnFail: { count: 10 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      jobId: 'federation-envelope-retention',
    },
  );

  scanner
    ?.ping()
    .then((ok) =>
      log.info({ clamav: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT, alive: ok }, 'clamav ping'),
    )
    .catch(() => undefined);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    // SHUTDOWN-DEADLINE: cap the graceful drain at 8s so a hung in-flight
    // scan job (slow clamd, network stall) can't block past Docker's default
    // stop_grace_period (10s) and trigger a SIGKILL that loses BullMQ locks
    // for the active job.
    const drainDeadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 8_000),
    );
    const drain = Promise.all([
      worker.close(),
      maintenanceWorker.close(),
      maintenanceQueue.close(),
      federationOutboxHandle?.close() ?? Promise.resolve(),
    ]).then(() => 'drained' as const);
    const result = await Promise.race([drain, drainDeadline]);
    if (result === 'timeout') {
      log.warn({ deadlineMs: 8_000 }, 'shutdown deadline hit; forcing exit');
    }
    // Only after the drain settles (or times out) is it safe to drop the
    // Redis connections. `quit` waits for pending commands to be acked
    // rather than `disconnect`'s fire-and-forget.
    try {
      await Promise.all([connection.quit(), gatewayPublisher.quit()]);
    } catch (err) {
      log.warn({ err }, 'redis quit failed; forcing disconnect');
      connection.disconnect();
      gatewayPublisher.disconnect();
    }
    process.exit(result === 'timeout' ? 1 : 0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info({ queue: SCAN_QUEUE }, 'tavern worker ready');
}

function createStorage(cfg: WorkerConfig): StorageBackend {
  if (cfg.STORAGE_BACKEND === 's3') {
    return new S3StorageBackend({
      endpoint: cfg.S3_ENDPOINT!,
      region: cfg.S3_REGION,
      accessKey: cfg.S3_ACCESS_KEY!,
      secretKey: cfg.S3_SECRET_KEY!,
      useSsl: cfg.S3_USE_SSL,
      mainBucket: cfg.S3_BUCKET,
      quarantineBucket: cfg.S3_QUARANTINE_BUCKET,
      apiBaseUrl: cfg.API_BASE_URL,
      publicEndpoint: cfg.S3_PUBLIC_ENDPOINT,
      publicUseSsl: cfg.S3_PUBLIC_USE_SSL,
    });
  }
  return new LocalStorageBackend({
    dataDir: path.resolve(cfg.LOCAL_STORAGE_DIR),
    mainBucket: cfg.S3_BUCKET,
    quarantineBucket: cfg.S3_QUARANTINE_BUCKET,
    apiBaseUrl: cfg.API_BASE_URL,
  });
}

/**
 * Strip credentials from a redis:// URL before logging. Logs aggregators
 * (Loki / CloudWatch / Datadog) retain values indefinitely; the connection
 * string can carry a password in the userinfo component.
 */
function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.username || u.password ? `${u.protocol}//[redacted]@${u.host}` : `${u.protocol}//${u.host}`;
  } catch {
    // If the URL doesn't parse (unusual scheme, ioredis-tolerated shorthand),
    // fall back to a permissive token strip: drop anything between `://` and `@`.
    return url.replace(/(\w+:\/\/)[^@\s]+@/, '$1[redacted]@');
  }
}

void main();
