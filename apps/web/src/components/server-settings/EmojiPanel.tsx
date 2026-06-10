import { useEffect, useState } from 'react';
import type { CustomEmoji } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { uploadFile } from '../../lib/uploads.js';
import { awaitTerminal } from '../../lib/attachment-ready.js';
import { ConfirmDialog } from '../ConfirmDialog.js';
import { Modal } from '../Modal.js';

export function EmojiPanel({ serverId }: { serverId: string }): JSX.Element {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [emojiName, setEmojiName] = useState('');
  const [emojiToDelete, setEmojiToDelete] = useState<CustomEmoji | null>(null);

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

  function onUpload(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setEmojiName(defaultEmojiName(file.name));
    setPendingUpload(file);
  }

  async function createPendingEmoji(): Promise<void> {
    const file = pendingUpload;
    const name = emojiName.trim();
    if (!file) return;
    if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) {
      setError('Use 1-32 letters, digits, or underscores for the emoji name.');
      return;
    }
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
      setPendingUpload(null);
      setEmojiName('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(emoji: CustomEmoji): Promise<void> {
    try {
      await api(`/emojis/${emoji.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setEmojiToDelete(null);
    }
  }

  return (
    <div className="space-y-4">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="file"
          accept="image/png,image/gif,image/webp,image/jpeg"
          className="hidden"
          onChange={onUpload}
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
              onClick={() => setEmojiToDelete(e)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <Modal
        open={pendingUpload !== null}
        onOpenChange={(open) => {
          if (open || busy) return;
          setPendingUpload(null);
          setEmojiName('');
        }}
        title="Name custom emoji"
        description="Use letters, digits, and underscores so it is easy to type at the table."
        footer={
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setPendingUpload(null);
                setEmojiName('');
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void createPendingEmoji()}
              disabled={busy || !emojiName.trim()}
            >
              {busy ? 'Uploading...' : 'Create emoji'}
            </button>
          </>
        }
      >
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Emoji name</span>
          <input
            className="input"
            value={emojiName}
            onChange={(e) => setEmojiName(e.target.value)}
            maxLength={32}
            disabled={busy}
            autoFocus
          />
        </label>
      </Modal>
      {emojiToDelete ? (
        <ConfirmDialog
          title="Delete emoji?"
          description={`Delete :${emojiToDelete.name}: from this tavern?`}
          confirmLabel="Delete emoji"
          destructive
          onConfirm={() => void remove(emojiToDelete)}
          onCancel={() => setEmojiToDelete(null)}
        />
      ) : null}
    </div>
  );
}

function defaultEmojiName(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]*$/, '');
  const cleaned = withoutExtension.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 32) || 'custom_emoji';
}
