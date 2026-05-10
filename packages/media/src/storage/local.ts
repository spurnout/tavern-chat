import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageBackend, type ObjectStat, type StorageMode, type UploadTicket } from './types.js';

export interface LocalStorageConfig {
  /** Root directory on disk; bucket subdirectories live inside. */
  dataDir: string;
  mainBucket: string;
  quarantineBucket: string;
  /** API base URL — e.g. http://localhost:3001 — used to build presigned + public URLs. */
  apiBaseUrl: string;
}

interface PendingUpload {
  bucket: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
}

/**
 * Filesystem-backed storage backend.
 *
 * "Presigned PUT URLs" are short-lived tokens pointing at our own API; the
 * client PUTs to the API, which streams the body to disk via `acceptUpload`.
 * Public reads go through `/api/_local-files/<bucket>/<key>`.
 *
 * Suitable for dev and small self-hosted instances. For larger deployments,
 * use the S3 backend backed by MinIO (or a real cloud store).
 */
export class LocalStorageBackend extends StorageBackend {
  readonly mode: StorageMode = 'local';
  readonly mainBucket: string;
  readonly quarantineBucket: string;

  private readonly dataDir: string;
  private readonly apiBaseUrl: string;
  private readonly tickets = new Map<string, PendingUpload>();

  constructor(cfg: LocalStorageConfig) {
    super();
    this.dataDir = path.resolve(cfg.dataDir);
    this.mainBucket = cfg.mainBucket;
    this.quarantineBucket = cfg.quarantineBucket;
    this.apiBaseUrl = cfg.apiBaseUrl.replace(/\/$/, '');
  }

  bucketFor(quarantined: boolean): string {
    return quarantined ? this.quarantineBucket : this.mainBucket;
  }

  async ensureBuckets(): Promise<void> {
    for (const b of [this.mainBucket, this.quarantineBucket]) {
      mkdirSync(path.join(this.dataDir, b), { recursive: true });
    }
  }

  async presignPut(
    bucket: string,
    key: string,
    mimeType: string,
    sizeBytes: number,
    expirySeconds = 600,
  ): Promise<UploadTicket> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + expirySeconds * 1000);
    this.tickets.set(token, { bucket, key, mimeType, sizeBytes, expiresAt });
    this.purgeExpired();
    return {
      url: `${this.apiBaseUrl}/api/_local-uploads/${token}`,
      method: 'PUT',
      headers: { 'content-type': mimeType },
      expiresAt,
    };
  }

  /**
   * Called by the API's local-upload route. Validates the token, streams the
   * incoming body to disk, returns the (bucket, key) the upload landed at.
   */
  async acceptUpload(
    token: string,
    body: NodeJS.ReadableStream,
  ): Promise<{ bucket: string; key: string }> {
    const ticket = this.tickets.get(token);
    if (!ticket) throw new Error('Unknown upload token');
    if (ticket.expiresAt < new Date()) {
      this.tickets.delete(token);
      throw new Error('Upload token expired');
    }
    this.tickets.delete(token);
    const targetPath = this.absPath(ticket.bucket, ticket.key);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    await pipeline(body, createWriteStream(targetPath));
    return { bucket: ticket.bucket, key: ticket.key };
  }

  async getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.absPath(bucket, key));
  }

  async getPartialObject(bucket: string, key: string, length: number): Promise<Buffer> {
    const buf = await readFile(this.absPath(bucket, key));
    return buf.subarray(0, Math.min(length, buf.length));
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    _contentType: string,
  ): Promise<void> {
    const target = this.absPath(bucket, key);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }

  async statObject(bucket: string, key: string): Promise<ObjectStat> {
    const s = await stat(this.absPath(bucket, key));
    const etag = createHash('md5').update(`${s.size}:${s.mtimeMs}`).digest('hex');
    return { size: s.size, etag };
  }

  async copyObject(
    fromBucket: string,
    fromKey: string,
    toBucket: string,
    toKey: string,
  ): Promise<void> {
    const src = this.absPath(fromBucket, fromKey);
    const dst = this.absPath(toBucket, toKey);
    if (!existsSync(src)) throw new Error(`Source not found: ${fromBucket}/${fromKey}`);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    void statSync(dst); // touch to verify
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    const target = this.absPath(bucket, key);
    if (existsSync(target)) rmSync(target, { force: true });
  }

  getPublicUrl(bucket: string, key: string): string {
    return `${this.apiBaseUrl}/api/_local-files/${bucket}/${encodeURIComponent(key)}`;
  }

  /**
   * Resolve an absolute on-disk path for a (bucket, key). Refuses any path
   * that would escape the bucket directory — defensive against malicious
   * keys with `..` segments.
   */
  resolveSafe(bucket: string, key: string): string | null {
    if (bucket !== this.mainBucket && bucket !== this.quarantineBucket) return null;
    const bucketDir = path.join(this.dataDir, bucket);
    const target = path.join(bucketDir, key);
    const normalised = path.resolve(target);
    if (!normalised.startsWith(path.resolve(bucketDir) + path.sep)) {
      return null;
    }
    return normalised;
  }

  private absPath(bucket: string, key: string): string {
    const safe = this.resolveSafe(bucket, key);
    if (!safe) throw new Error(`Invalid storage path: ${bucket}/${key}`);
    return safe;
  }

  private purgeExpired(): void {
    const now = new Date();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(token);
    }
  }
}
