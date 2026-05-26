import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3StorageBackend, type S3StorageConfig } from './s3.js';

// minio's Client is used twice in the two-endpoint path (once for internal,
// once for presigning). We need each instance to remember which endpoint it
// was constructed against so the test can assert the right one signed the
// presigned URL.

interface CapturedClient {
  endPoint: string;
  port: number;
  useSSL: boolean;
  presignedPutObject: ReturnType<typeof vi.fn>;
}

const captured: CapturedClient[] = [];

vi.mock('minio', () => ({
  Client: vi.fn().mockImplementation((opts: { endPoint: string; port: number; useSSL: boolean }) => {
    const client: CapturedClient = {
      endPoint: opts.endPoint,
      port: opts.port,
      useSSL: opts.useSSL,
      presignedPutObject: vi.fn(async (bucket: string, key: string) => {
        const proto = client.useSSL ? 'https' : 'http';
        const portSuffix =
          (client.useSSL && client.port === 443) || (!client.useSSL && client.port === 80)
            ? ''
            : `:${client.port}`;
        return `${proto}://${client.endPoint}${portSuffix}/${bucket}/${key}?X-Amz-Signature=fake`;
      }),
    };
    captured.push(client);
    return client;
  }),
}));

const baseCfg = {
  region: 'garage',
  accessKey: 'AKIA',
  secretKey: 'secret',
  mainBucket: 'tavern-media',
  quarantineBucket: 'tavern-quarantine',
  apiBaseUrl: 'https://chat.example.com',
} satisfies Omit<S3StorageConfig, 'endpoint' | 'useSsl'>;

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

function clientAt(i: number): CapturedClient {
  const c = captured[i];
  if (!c) throw new Error(`expected captured client at index ${i}, got ${captured.length} total`);
  return c;
}

describe('S3StorageBackend.presignPut', () => {
  it('signs against the internal endpoint when publicEndpoint is unset (backwards compat)', async () => {
    const backend = new S3StorageBackend({
      ...baseCfg,
      endpoint: 'http://garage:3900',
      useSsl: false,
    });

    // One client only — single-endpoint path.
    expect(captured).toHaveLength(1);

    const ticket = await backend.presignPut('tavern-media', 'foo/bar.png', 'image/png', 1234);
    expect(ticket.url).toMatch(/^http:\/\/garage:3900\//);
    expect(clientAt(0).presignedPutObject).toHaveBeenCalledTimes(1);
  });

  it('signs against publicEndpoint when set, keeping internal ops on the primary endpoint', async () => {
    const backend = new S3StorageBackend({
      ...baseCfg,
      endpoint: 'http://garage:3900',
      useSsl: false,
      publicEndpoint: 'https://garage.example.com',
      publicUseSsl: true,
    });

    // Two clients — internal + presign.
    expect(captured).toHaveLength(2);
    const internal = clientAt(0);
    const presign = clientAt(1);
    expect(internal.endPoint).toBe('garage');
    expect(internal.useSSL).toBe(false);
    expect(presign.endPoint).toBe('garage.example.com');
    expect(presign.useSSL).toBe(true);

    const ticket = await backend.presignPut('tavern-media', 'foo/bar.png', 'image/png', 1234);
    // The presign must use the PUBLIC client — the host the browser will
    // actually send. AWS sig v4 signs the Host header, so any post-hoc URL
    // rewrite would fail verification at the S3 server.
    expect(ticket.url).toMatch(/^https:\/\/garage\.example\.com\//);
    expect(internal.presignedPutObject).not.toHaveBeenCalled();
    expect(presign.presignedPutObject).toHaveBeenCalledTimes(1);
  });

  it('defaults publicUseSsl to useSsl when not specified', async () => {
    new S3StorageBackend({
      ...baseCfg,
      endpoint: 'http://garage:3900',
      useSsl: true,
      publicEndpoint: 'https://garage.example.com',
      // publicUseSsl omitted on purpose
    });

    expect(captured).toHaveLength(2);
    expect(clientAt(1).useSSL).toBe(true);
  });
});
