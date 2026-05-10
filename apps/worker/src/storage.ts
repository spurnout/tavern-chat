import { Client as MinioClient } from 'minio';
import type { WorkerConfig } from './config.js';

export function makeStorageClient(cfg: WorkerConfig): MinioClient {
  const url = new URL(cfg.S3_ENDPOINT);
  return new MinioClient({
    endPoint: url.hostname,
    port: Number(url.port) || (cfg.S3_USE_SSL ? 443 : 80),
    useSSL: cfg.S3_USE_SSL,
    accessKey: cfg.S3_ACCESS_KEY,
    secretKey: cfg.S3_SECRET_KEY,
    region: cfg.S3_REGION,
  });
}
