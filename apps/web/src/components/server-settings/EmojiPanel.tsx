import { useEffect, useState } from 'react';
import type { CustomEmoji } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { uploadFile } from '../../lib/uploads.js';
import { awaitTerminal } from '../../lib/attachment-ready.js';

export function EmojiPanel({ serverId }: { serverId: string }): JSX.Element {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const e = await api<CustomEmoji[]>(`/servers/${serverId}/emojis`);
      setEmojis(e);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load emoji');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const name = prompt('Name (letters, digits, underscore):', file.name.replace(/\..*$/, ''));
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const att = await uploadFile({ file, serverId, kind: 'image' });
      // FE-17: wait for the worker's ATTACHMENT_READY gateway event instead
      // of a fixed 800ms poll. The bus auto-resolves a short retry-poll
      // fallback if the gateway isn't connected (e.g. cold-start, dev with
      // no Redis), so a brief network blip doesn't strand the upload.
      const status = att.status === 'ready' ? 'ready' : await awaitTerminal(att.id, 15_000).catch(() => 'pending');
      if (status !== 'ready') {
        throw new Error(
          status === 'pending'
            ? 'Worker is still processing the upload — try again in a moment.'
            : `Attachment ${status} during processing.`,
        );
      }
      await api(`/servers/${serverId}/emojis`, {
        method: 'POST',
        body: { name, attachmentId: att.id },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete emoji?')) return;
    try {
      await api(`/emojis/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="space-y-4">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="file"
          accept="image/png,image/gif,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => void onUpload(e)}
          disabled={busy}
        />
        <span className="btn-primary">{busy ? 'Uploading…' : 'Upload custom emoji'}</span>
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-fg-muted">
        After upload, the worker scans &amp; processes the image. It may take a few seconds before
        the emoji shows below.
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {emojis.map((e) => (
          <li key={e.id} className="card flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded bg-raised text-lg">🖼</div>
            <div className="min-w-0 flex-1 truncate text-sm">:{e.name}:</div>
            <button
              className="text-xs text-danger hover:underline"
              onClick={() => void remove(e.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
