/**
 * Minimal ClamAV INSTREAM client.
 *
 * Talks to clamd over plain TCP using its INSTREAM protocol:
 *   1. Send "zINSTREAM\0".
 *   2. Send chunks: 4-byte big-endian length + chunk bytes.
 *   3. Send 4-byte zero length to terminate.
 *   4. Read newline-terminated response (e.g. "stream: OK\0" or
 *      "stream: Eicar-Test-Signature FOUND\0").
 *
 * Implementing this directly avoids pulling another npm dep that wraps the
 * same protocol and lets us add tight timeouts.
 *
 * If ClamAV isn't running (the default in dev mode), construct the scanner
 * anyway and call ping() first — `false` means "don't block uploads on a
 * scanner that isn't there." See ALLOW_UNSCANNED_UPLOADS in api config.
 */

import net from 'node:net';

export interface ScanResult {
  clean: boolean;
  signature?: string;
  raw: string;
}

export interface ScannerConfig {
  host: string;
  port: number;
  timeoutMs?: number;
  chunkSize?: number;
}

export class ClamAVScanner {
  constructor(private readonly cfg: ScannerConfig) {}

  async ping(): Promise<boolean> {
    try {
      const reply = await this.command(Buffer.from('zPING\0'));
      return reply.toString('utf8').toUpperCase().startsWith('PONG');
    } catch {
      return false;
    }
  }

  async scanStream(stream: NodeJS.ReadableStream): Promise<ScanResult> {
    const chunkSize = this.cfg.chunkSize ?? 64 * 1024;
    const sock = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
    const timeoutMs = this.cfg.timeoutMs ?? 30_000;

    return new Promise<ScanResult>((resolve, reject) => {
      let settled = false;
      const reply: Buffer[] = [];
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error('ClamAV scan timed out'));
      }, timeoutMs);

      sock.on('connect', () => {
        sock.write('zINSTREAM\0');

        const buffer: Buffer[] = [];
        let total = 0;
        const flush = (chunk: Buffer): boolean => {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          const ok1 = sock.write(len);
          const ok2 = sock.write(chunk);
          return ok1 && ok2;
        };

        stream.on('data', (data: Buffer) => {
          buffer.push(data);
          total += data.length;
          if (total >= chunkSize) {
            const merged = Buffer.concat(buffer, total);
            buffer.length = 0;
            total = 0;
            for (let off = 0; off < merged.length; off += chunkSize) {
              const slice = merged.subarray(off, Math.min(off + chunkSize, merged.length));
              flush(slice);
            }
          }
        });

        stream.on('end', () => {
          if (total > 0) {
            const merged = Buffer.concat(buffer, total);
            flush(merged);
          }
          const zero = Buffer.alloc(4);
          zero.writeUInt32BE(0, 0);
          sock.write(zero);
        });

        stream.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          sock.destroy();
          reject(err);
        });
      });

      sock.on('data', (data: Buffer) => {
        reply.push(data);
      });

      sock.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(reply).toString('utf8').replace(/\0$/, '').trim();
        const clean = /:\s*OK\b/.test(text);
        const found = text.match(/:\s*(.+?)\s+FOUND/);
        resolve({ clean, signature: found ? found[1] : undefined, raw: text });
      });

      sock.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async command(payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('ClamAV command timed out'));
      }, this.cfg.timeoutMs ?? 5_000);

      const chunks: Buffer[] = [];
      sock.on('connect', () => sock.end(payload));
      sock.on('data', (chunk) => chunks.push(chunk));
      sock.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
