/**
 * Object storage adapter (MinIO / S3-compatible).
 *
 * This wraps the minio client in a small, opinionated surface. We don't try to
 * abstract over multiple providers — only S3-compatible blob stores are
 * supported.
 */

import { Client as MinioClient, type ClientOptions } from 'minio';
import type { Config } from '../config.js';

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export class StorageService {
  private client: MinioClient;
  private mainBucket: string;
  private quarantineBucket: string;

  constructor(cfg: Config) {
    const url = new URL(cfg.S3_ENDPOINT);
    const opts: ClientOptions = {
      endPoint: url.hostname,
      port: Number(url.port) || (cfg.S3_USE_SSL ? 443 : 80),
      useSSL: cfg.S3_USE_SSL,
      accessKey: cfg.S3_ACCESS_KEY,
      secretKey: cfg.S3_SECRET_KEY,
      region: cfg.S3_REGION,
    };
    this.client = new MinioClient(opts);
    this.mainBucket = cfg.S3_BUCKET;
    this.quarantineBucket = cfg.S3_QUARANTINE_BUCKET;
  }

  bucketFor(quarantined: boolean): string {
    return quarantined ? this.quarantineBucket : this.mainBucket;
  }

  async ensureBuckets(): Promise<void> {
    for (const b of [this.mainBucket, this.quarantineBucket]) {
      const exists = await this.client.bucketExists(b).catch(() => false);
      if (!exists) await this.client.makeBucket(b);
    }
  }

  async presignPut(
    bucket: string,
    key: string,
    mimeType: string,
    sizeBytes: number,
    expirySeconds = 60 * 10,
  ): Promise<PresignedPut> {
    // The MinIO client signs PUT URLs with the listed headers as required.
    const url = await this.client.presignedPutObject(bucket, key, expirySeconds);
    return {
      url,
      headers: {
        'content-type': mimeType,
        'content-length': String(sizeBytes),
      },
      expiresAt: new Date(Date.now() + expirySeconds * 1000),
    };
  }

  async getObjectStream(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(bucket, key);
  }

  async statObject(bucket: string, key: string): Promise<{ size: number; etag: string }> {
    const stat = await this.client.statObject(bucket, key);
    return { size: stat.size, etag: stat.etag };
  }

  async copyObject(
    fromBucket: string,
    fromKey: string,
    toBucket: string,
    toKey: string,
  ): Promise<void> {
    // minio v8 prefers CopySource form
    await this.client.copyObject(toBucket, toKey, `/${fromBucket}/${fromKey}`);
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    await this.client.removeObject(bucket, key);
  }

  /** Move an object from main storage to the quarantine bucket. */
  async quarantine(key: string): Promise<void> {
    await this.copyObject(this.mainBucket, key, this.quarantineBucket, key);
    await this.removeObject(this.mainBucket, key);
  }
}
