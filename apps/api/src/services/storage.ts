/**
 * API-side storage factory.
 *
 * Returns a StorageBackend (from @tavern/media) configured per env. The
 * caller treats it polymorphically. Callers who specifically need the
 * local backend (e.g. the local-upload PUT route) should typecheck via
 * `instanceof LocalStorageBackend`.
 */

import {
  LocalStorageBackend,
  S3StorageBackend,
  type StorageBackend,
} from '@tavern/media';
import path from 'node:path';
import type { Config } from '../config.js';

export function createStorage(cfg: Config): StorageBackend {
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
    apiBaseUrl: cfg.PUBLIC_BASE_URL,
  });
}

export { LocalStorageBackend, S3StorageBackend };
export type { StorageBackend };
