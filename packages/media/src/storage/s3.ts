import { Client as S3Client, type ClientOptions } from 'minio';
import { StorageBackend, type ObjectStat, type StorageMode, type UploadTicket } from './types.js';

export interface S3StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  useSsl: boolean;
  mainBucket: string;
  quarantineBucket: string;
  /**
   * API base URL — public attachment URLs are routed through
   * `${apiBaseUrl}/api/_attachments/<bucket>/<key>`, which the API streams
   * from the S3 backend with authenticated calls. Lets Tavern target any
   * S3-compatible store without exposing the bucket publicly.
   */
  apiBaseUrl: string;
}

/**
 * S3-compatible storage backend (Garage, AWS, MinIO, Backblaze B2, R2, …).
 *
 * Uses the `minio` npm package for the wire protocol (works against any
 * S3-compatible server). Presigned PUT URLs go straight to the bucket; public
 * GETs are proxied via the API so we don't need anonymous bucket policies.
 */
export class S3StorageBackend extends StorageBackend {
  readonly mode: StorageMode = 's3';
  readonly mainBucket: string;
  readonly quarantineBucket: string;

  private readonly client: S3Client;
  private readonly apiBaseUrl: string;

  constructor(cfg: S3StorageConfig) {
    super();
    const url = new URL(cfg.endpoint);
    const opts: ClientOptions = {
      endPoint: url.hostname,
      port: Number(url.port) || (cfg.useSsl ? 443 : 80),
      useSSL: cfg.useSsl,
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
      region: cfg.region,
    };
    this.client = new S3Client(opts);
    this.mainBucket = cfg.mainBucket;
    this.quarantineBucket = cfg.quarantineBucket;
    this.apiBaseUrl = cfg.apiBaseUrl.replace(/\/$/, '');
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
    expirySeconds = 600,
  ): Promise<UploadTicket> {
    const url = await this.client.presignedPutObject(bucket, key, expirySeconds);
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': mimeType,
        'content-length': String(sizeBytes),
      },
      expiresAt: new Date(Date.now() + expirySeconds * 1000),
    };
  }

  async getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(bucket, key);
  }

  async getPartialObject(bucket: string, key: string, length: number): Promise<Buffer> {
    const stream = await this.client.getPartialObject(bucket, key, 0, length);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.putObject(bucket, key, body, body.length, {
      'content-type': contentType,
    });
  }

  async statObject(bucket: string, key: string): Promise<ObjectStat> {
    const stat = await this.client.statObject(bucket, key);
    return { size: stat.size, etag: stat.etag };
  }

  async copyObject(
    fromBucket: string,
    fromKey: string,
    toBucket: string,
    toKey: string,
  ): Promise<void> {
    await this.client.copyObject(toBucket, toKey, `/${fromBucket}/${fromKey}`);
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    await this.client.removeObject(bucket, key);
  }

  getPublicUrl(bucket: string, key: string): string {
    return `${this.apiBaseUrl}/api/_attachments/${bucket}/${encodeURIComponent(key)}`;
  }
}
