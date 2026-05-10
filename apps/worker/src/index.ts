// Side-effect import — must come first so .env populates process.env.
import './load-env.js';

import pino from 'pino';
import { loadWorkerConfig } from './config.js';
import { QUEUE_NAMES, makeRedisConnection, makeWorker } from './queues.js';
import { ClamAVScanner } from './scanner.js';
import { makeStorageClient } from './storage.js';
import { processScanJob } from './jobs/upload-pipeline.js';

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      cfg.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { colorize: true } },
  });

  log.info({ redis: cfg.REDIS_URL }, 'tavern worker starting');

  const connection = makeRedisConnection(cfg.REDIS_URL);
  const s3 = makeStorageClient(cfg);
  const scanner = new ClamAVScanner({ host: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT });

  const scanWorker = makeWorker<{ attachmentId: string }>(
    QUEUE_NAMES.uploadScan,
    async (job) => {
      log.info({ jobId: job.id, attachmentId: job.data.attachmentId }, 'scan job received');
      await processScanJob(job.data, { cfg, s3, scanner, log });
    },
    connection,
  );

  // Phase 0 stubs for the queues we haven't filled in yet.
  const stubs = [
    QUEUE_NAMES.uploadValidate,
    QUEUE_NAMES.uploadFinalize,
    QUEUE_NAMES.mediaProcess,
    QUEUE_NAMES.voiceMessageWaveform,
    QUEUE_NAMES.systemMaintenance,
  ].map((name) =>
    makeWorker(
      name,
      async (job) => {
        log.info({ queue: name, jobId: job.id, name: job.name }, 'received job (stub)');
        return { stub: true };
      },
      connection,
    ),
  );

  const workers = [scanWorker, ...stubs];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      log.error({ jobId: job?.id, err: err.message }, 'job failed');
    });
  }

  // Optional ClamAV ping for log hygiene; not fatal if it fails.
  scanner
    .ping()
    .then((ok) =>
      log.info({ clamav: cfg.CLAMAV_HOST, port: cfg.CLAMAV_PORT, alive: ok }, 'clamav ping'),
    )
    .catch(() => undefined);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info({ queues: Object.values(QUEUE_NAMES) }, 'tavern worker ready');
}

void main();
