import type { Attachment, AttachmentKind, RequestUploadResponse } from '@tavern/shared';
import { ApiError, api } from './api-client.js';

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

export async function uploadFile(
  args: PresignArgs,
  onProgress?: (p: UploadProgress) => void,
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
  return finalised;
}
