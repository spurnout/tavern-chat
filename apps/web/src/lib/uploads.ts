import type { Attachment, AttachmentKind, RequestUploadResponse } from '@tavern/shared';
import { ApiError, api } from './api-client.js';
import { decodeAudioPeaks } from './waveform.js';

interface PresignArgs {
  file: File;
  channelId?: string;
  serverId?: string;
  kind?: AttachmentKind;
}

function inferKind(mime: string): AttachmentKind {
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export type UploadStrategyInfo = RequestUploadResponse['upload'];

export async function uploadFile(
  args: PresignArgs,
  onProgress?: (p: UploadProgress) => void,
  onStrategy?: (info: UploadStrategyInfo) => void,
): Promise<Attachment> {
  const kind = args.kind ?? inferKind(args.file.type);

  const presigned = await api<RequestUploadResponse>('/uploads', {
    method: 'POST',
    body: {
      kind,
      filename: args.file.name,
      mimeType: args.file.type || 'application/octet-stream',
      sizeBytes: args.file.size,
      ...(args.channelId ? { channelId: args.channelId } : {}),
      ...(args.serverId ? { serverId: args.serverId } : {}),
    },
  });
  onStrategy?.(presigned.upload);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(presigned.upload.method, presigned.upload.url);
    for (const [k, v] of Object.entries(presigned.upload.headers)) {
      // Browsers refuse to set some headers on cross-origin PUT, e.g. content-length
      // — we skip those and let fetch/XHR figure them out.
      if (k.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError('UPLOAD_BLOCKED', `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Upload failed', 0));
    xhr.send(args.file);
  });

  const finalised = await api<Attachment>(`/uploads/${presigned.attachment.id}/complete`, {
    method: 'POST',
  });

  // Voice messages get a client-computed waveform. The worker doesn't have
  // ffmpeg available to decode webm/opus, so we use the browser's AudioContext.
  if (kind === 'voice_message') {
    try {
      const { peaks, durationMs } = await decodeAudioPeaks(args.file, 32);
      const updated = await api<Attachment>(`/attachments/${finalised.id}/waveform`, {
        method: 'POST',
        body: { peaks, durationMs },
      });
      return updated;
    } catch {
      // Fall back to the placeholder waveform written by the worker.
      return finalised;
    }
  }

  return finalised;
}
