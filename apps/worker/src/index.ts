// Side-effect import — must come first so .env populates process.env.
import './load-env.js';

import pino from 'pino';
import path from 'node:path';
import { Worker, type Processor } from 'bullmq';
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

const SCAN_QUEUE = 'tavern.upload.scan';

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
    log.info(
      'REDIS_URL is not set. In-process mode: the api runs the upload ' +
        'pipeline directly, so this worker has nothing to do. Exiting.',
    );
    return;
  }

  log.info({ redis: cfg.REDIS_URL }, 'tavern worker starting');

  const storage = createStorage(cfg);
  const scanner = cfg.CLAMAV_HOST
    ? new ClamAVScanner({ host: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT })
    : null;

  const connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });

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
    });
  };

  const worker = new Worker<{ attachmentId: string }>(SCAN_QUEUE, processor, {
    connection,
    concurrency: 4,
  });

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, err: err.message }, 'job failed');
  });

  scanner
    ?.ping()
    .then((ok) =>
      log.info({ clamav: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT, alive: ok }, 'clamav ping'),
    )
    .catch(() => undefined);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    await worker.close();
    connection.disconnect();
    process.exit(0);
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
      publicBaseUrl: cfg.S3_PUBLIC_BASE_URL,
    });
  }
  return new LocalStorageBackend({
    dataDir: path.resolve(cfg.LOCAL_STORAGE_DIR),
    mainBucket: cfg.S3_BUCKET,
    quarantineBucket: cfg.S3_QUARANTINE_BUCKET,
    apiBaseUrl: cfg.API_BASE_URL,
  });
}

void main();
