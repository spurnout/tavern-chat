/**
 * BullMQ queue definitions used by Tavern.
 *
 * Phase 0 wires up the queues but does not enqueue jobs yet.
 * Phase 2 attaches the upload pipeline (validate -> ClamAV scan -> finalize).
 * Phase 3 attaches media post-processing (sharp / ffprobe / waveform).
 */

import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';
import IORedis from 'ioredis';

export const QUEUE_NAMES = {
  uploadValidate: 'tavern.upload.validate',
  uploadScan: 'tavern.upload.scan',
  uploadFinalize: 'tavern.upload.finalize',
  mediaProcess: 'tavern.media.process',
  voiceMessageWaveform: 'tavern.voice.waveform',
  systemMaintenance: 'tavern.maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function makeRedisConnection(url: string): ConnectionOptions {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function makeQueue<T = unknown>(
  name: QueueName,
  connection: ConnectionOptions,
  defaultJobOptions?: JobsOptions,
): Queue<T> {
  return new Queue<T>(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 },
      removeOnFail: { age: 60 * 60 * 24 * 7, count: 1000 },
      backoff: { type: 'exponential', delay: 5_000 },
      ...defaultJobOptions,
    },
  });
}

export function makeWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  connection: ConnectionOptions,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection,
    concurrency: 4,
  });
}
