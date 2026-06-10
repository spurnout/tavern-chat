import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, RequestUploadResponse } from '@tavern/shared';
import { uploadFile } from './uploads.js';
import { api } from './api-client.js';

vi.mock('./api-client.js', () => {
  class ApiError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return { ApiError, api: vi.fn() };
});

vi.mock('./waveform.js', () => ({
  decodeAudioPeaks: vi.fn(),
}));

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
  readonly headers: Record<string, string> = {};
  method = '';
  url = '';
  status = 204;
  onload?: () => void;
  onerror?: () => void;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: File): void {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: body.size,
      total: body.size,
    } as ProgressEvent);
    this.onload?.();
  }
}

const originalXhr = globalThis.XMLHttpRequest;

afterEach(() => {
  vi.clearAllMocks();
  FakeXMLHttpRequest.instances = [];
  globalThis.XMLHttpRequest = originalXhr;
});

describe('uploadFile', () => {
  it('reports throttled upload metadata and progress before completing', async () => {
    globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const attachment = makeAttachment('att_1');
    const complete = { ...attachment, status: 'uploaded' as const };
    vi.mocked(api)
      .mockResolvedValueOnce({
        attachment,
        upload: {
          method: 'PUT',
          url: 'http://localhost:3001/api/_governed-uploads/token',
          headers: { 'content-type': 'application/octet-stream' },
          expiresAt: new Date().toISOString(),
          strategy: 'tavern_throttled',
          voiceActive: true,
          maxBytesPerSecond: 256 * 1024,
        },
      } satisfies RequestUploadResponse)
      .mockResolvedValueOnce(complete);

    const onProgress = vi.fn();
    const onStrategy = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], 'note.txt', {
      type: 'text/plain',
    });

    await expect(uploadFile({ file, channelId: 'ch_1' }, onProgress, onStrategy)).resolves.toEqual(
      complete,
    );

    expect(onStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'tavern_throttled',
        voiceActive: true,
        maxBytesPerSecond: 256 * 1024,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith({ loaded: 3, total: 3 });
    expect(FakeXMLHttpRequest.instances[0]?.url).toContain('/api/_governed-uploads/');
  });
});

function makeAttachment(id: string): Attachment {
  return {
    id,
    uploaderId: 'user_1',
    serverId: null,
    channelId: 'ch_1',
    messageId: null,
    kind: 'file',
    filename: 'note.txt',
    mimeType: 'text/plain',
    sizeBytes: 3,
    width: null,
    height: null,
    durationMs: null,
    waveform: null,
    thumbnailUrl: null,
    url: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}
