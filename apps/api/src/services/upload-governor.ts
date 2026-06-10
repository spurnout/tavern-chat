import { randomBytes } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '@tavern/db';
import { UploadRejectedError, type StorageBackend, type UploadTicket } from '@tavern/media';
import type { Config } from '../config.js';

interface GovernedUploadTicket {
  bucket: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface GovernedUploadStrategy extends UploadTicket {
  strategy: 'tavern_throttled';
  voiceActive: true;
  maxBytesPerSecond: number;
}

interface CreateTicketArgs {
  bucket: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Protects voice quality on constrained upstream links by routing uploads
 * through Tavern whenever a voice room has at least two active participants.
 */
export class UploadGovernor {
  private readonly enabled: boolean;
  private readonly publicBaseUrl: string;
  private readonly bytesPerSecond: number;
  private readonly burstBytes: number;
  private readonly maxConcurrent: number;
  private readonly ticketExpirySeconds: number;
  private readonly tickets = new Map<string, GovernedUploadTicket>();
  private readonly waiters: Array<() => void> = [];
  private readonly sweepInterval: ReturnType<typeof setInterval>;
  private activeUploads = 0;

  constructor(cfg: Config) {
    this.enabled = cfg.VOICE_ACTIVE_UPLOAD_THROTTLE_ENABLED;
    this.publicBaseUrl = cfg.PUBLIC_BASE_URL.replace(/\/$/, '');
    this.bytesPerSecond = cfg.VOICE_ACTIVE_UPLOAD_THROTTLE_BYTES_PER_SECOND;
    this.burstBytes = cfg.VOICE_ACTIVE_UPLOAD_THROTTLE_BURST_BYTES;
    this.maxConcurrent = cfg.VOICE_ACTIVE_UPLOAD_THROTTLE_MAX_CONCURRENT;
    this.ticketExpirySeconds = cfg.S3_PRESIGN_EXPIRY_SECONDS;
    this.sweepInterval = setInterval(() => this.purgeExpiredTickets(), 60_000);
    if (typeof (this.sweepInterval as { unref?: () => void }).unref === 'function') {
      (this.sweepInterval as { unref: () => void }).unref();
    }
  }

  close(): void {
    clearInterval(this.sweepInterval);
  }

  async shouldThrottleUpload(): Promise<boolean> {
    if (!this.enabled) return false;
    const activeRooms = await prisma.$queryRaw<Array<{ active: number }>>`
      SELECT 1 AS active
      FROM "VoiceState"
      WHERE "channelId" IS NOT NULL
      GROUP BY "channelId"
      HAVING COUNT(*) >= 2
      LIMIT 1
    `;
    return activeRooms.length > 0;
  }

  createGovernedTicket(args: CreateTicketArgs): GovernedUploadStrategy {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ticketExpirySeconds * 1000);
    this.tickets.set(token, { ...args, expiresAt });
    this.purgeExpiredTickets();
    return {
      method: 'PUT',
      url: `${this.publicBaseUrl}/api/_governed-uploads/${token}`,
      headers: { 'content-type': 'application/octet-stream' },
      expiresAt,
      strategy: 'tavern_throttled',
      voiceActive: true,
      maxBytesPerSecond: this.bytesPerSecond,
    };
  }

  async acceptGovernedUpload(
    token: string,
    body: Readable,
    storage: StorageBackend,
  ): Promise<{ bucket: string; key: string }> {
    const ticket = this.consumeTicket(token);
    await this.processUpload(
      body,
      async (stream) => {
        await storage.putObjectStream(
          ticket.bucket,
          ticket.key,
          stream,
          ticket.mimeType,
          ticket.sizeBytes,
        );
      },
      { forceThrottle: true, exactBytes: ticket.sizeBytes },
    );
    return { bucket: ticket.bucket, key: ticket.key };
  }

  async processUpload<T>(
    body: Readable,
    handler: (stream: Readable) => Promise<T>,
    opts: { forceThrottle?: boolean; exactBytes?: number } = {},
  ): Promise<T> {
    const throttle = opts.forceThrottle === true || (await this.shouldThrottleUpload());
    if (!throttle && opts.exactBytes === undefined) {
      return handler(body);
    }

    const release = throttle ? await this.acquireSlot() : () => undefined;
    try {
      const stream = this.buildUploadStream(body, {
        throttle,
        exactBytes: opts.exactBytes,
      });
      return await handler(stream);
    } finally {
      release();
    }
  }

  private consumeTicket(token: string): GovernedUploadTicket {
    const ticket = this.tickets.get(token);
    if (!ticket) throw new UploadRejectedError('Unknown upload token');
    if (ticket.expiresAt < new Date()) {
      this.tickets.delete(token);
      throw new UploadRejectedError('Upload token expired');
    }
    this.tickets.delete(token);
    return ticket;
  }

  private async acquireSlot(): Promise<() => void> {
    while (this.activeUploads >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeUploads += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeUploads = Math.max(0, this.activeUploads - 1);
      this.waiters.shift()?.();
    };
  }

  private buildUploadStream(
    source: Readable,
    opts: { throttle: boolean; exactBytes?: number },
  ): Readable {
    let current = source;
    // Size guard first: an over-size body is rejected as soon as the excess
    // byte arrives, instead of after the throttle has slow-walked it — that
    // frees the governed upload slot immediately.
    if (opts.exactBytes !== undefined) {
      current = pipeWithErrorForwarding(current, createExactSizeGuard(opts.exactBytes));
    }
    if (opts.throttle) {
      current = pipeWithErrorForwarding(current, this.createThrottleStream());
    }
    return current;
  }

  private createThrottleStream(): Transform {
    const bytesPerSecond = this.bytesPerSecond;
    const burstBytes = this.burstBytes;
    let tokens = burstBytes;
    let lastRefill = Date.now();

    const refill = () => {
      const now = Date.now();
      const elapsedSeconds = (now - lastRefill) / 1000;
      if (elapsedSeconds <= 0) return;
      tokens = Math.min(burstBytes, tokens + elapsedSeconds * bytesPerSecond);
      lastRefill = now;
    };

    const takeTokens = async (bytes: number) => {
      while (true) {
        refill();
        if (tokens >= bytes) {
          tokens -= bytes;
          return;
        }
        const missing = bytes - tokens;
        const waitMs = Math.max(1, Math.ceil((missing / bytesPerSecond) * 1000));
        await sleep(waitMs);
      }
    };

    return new Transform({
      async transform(this: Transform, chunk: Buffer, _encoding, callback) {
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const end = Math.min(offset + burstBytes, chunk.length);
            const piece = chunk.subarray(offset, end);
            await takeTokens(piece.length);
            this.push(piece);
            offset = end;
          }
          callback();
        } catch (err) {
          callback(toError(err));
        }
      },
    });
  }

  private purgeExpiredTickets(): void {
    const now = new Date();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(token);
    }
  }
}

function createExactSizeGuard(expectedBytes: number): Transform {
  let bytesRead = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > expectedBytes) {
        callback(new UploadRejectedError(`Upload exceeds declared size (${expectedBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (bytesRead !== expectedBytes) {
        callback(
          new UploadRejectedError(`Upload ended at ${bytesRead} bytes; expected ${expectedBytes}`),
        );
        return;
      }
      callback();
    },
  });
}

function pipeWithErrorForwarding(
  source: Readable,
  target: Transform,
): Readable {
  source.on('error', (err) => target.destroy(toError(err)));
  return source.pipe(target);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
