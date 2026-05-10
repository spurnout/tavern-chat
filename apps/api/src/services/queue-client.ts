/**
 * BullMQ producer client for the API process.
 * The worker consumes from these same queue names.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { Config } from '../config.js';

export const QUEUE_NAMES = {
  uploadScan: 'tavern.upload.scan',
} as const;

let connection: ConnectionOptions | null = null;
let scanQueue: Queue<{ attachmentId: string }> | null = null;

export function getQueueClient(cfg: Config): {
  enqueueScan: (attachmentId: string) => Promise<void>;
} {
  if (!connection) {
    connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
  }
  if (!scanQueue) {
    scanQueue = new Queue<{ attachmentId: string }>(QUEUE_NAMES.uploadScan, { connection });
  }
  return {
    enqueueScan: async (attachmentId) => {
      await scanQueue!.add('scan', { attachmentId }, { jobId: `scan:${attachmentId}` });
    },
  };
}
