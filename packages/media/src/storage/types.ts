export interface UploadTicket {
  /** URL the client PUTs the file to. */
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStat {
  size: number;
  etag: string;
}

export type StorageMode = 'local' | 's3';

/**
 * Polymorphic object-storage interface. Both S3 and local-disk backends
 * implement this; the upload pipeline depends only on the interface.
 */
export abstract class StorageBackend {
  /**
   * "local" or "s3" — set by the concrete subclass. Useful when the API
   * needs to know whether to expose its local-upload route.
   */
  abstract readonly mode: StorageMode;

  /** Bucket names — the backend owns these so we don't repeat them everywhere. */
  abstract readonly mainBucket: string;
  abstract readonly quarantineBucket: string;

  /** Idempotently create both buckets / directories. Best-effort. */
  abstract ensureBuckets(): Promise<void>;

  /** Issue a one-time upload URL the client will PUT to. */
  abstract presignPut(
    bucket: string,
    key: string,
    mimeType: string,
    sizeBytes: number,
    expirySeconds?: number,
  ): Promise<UploadTicket>;

  /** Stream an object out for processing (e.g. ClamAV). */
  abstract getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;

  /** Read at most `length` bytes from offset 0 — used for magic-byte sniffs. */
  abstract getPartialObject(bucket: string, key: string, length: number): Promise<Buffer>;

  /** Write a buffer (used for thumbnails and EXIF-stripped re-encodes). */
  abstract putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;

  abstract statObject(bucket: string, key: string): Promise<ObjectStat>;

  abstract copyObject(
    fromBucket: string,
    fromKey: string,
    toBucket: string,
    toKey: string,
  ): Promise<void>;

  abstract removeObject(bucket: string, key: string): Promise<void>;

  /**
   * Return a URL the API responds with so clients can fetch this object
   * (e.g. for image src).
   */
  abstract getPublicUrl(bucket: string, key: string): string;

  abstract bucketFor(quarantined: boolean): string;

  /** Move from main → quarantine. Default impl uses copy + remove. */
  async quarantine(key: string): Promise<void> {
    await this.copyObject(this.mainBucket, key, this.quarantineBucket, key);
    await this.removeObject(this.mainBucket, key);
  }

  /**
   * Release any resources held by the backend (timers, sockets). The default
   * is a no-op; concrete backends override when they own state that outlives
   * a request (e.g. the local backend's ticket-sweep interval, STO-002).
   */
  close(): void {
    /* no-op */
  }
}
