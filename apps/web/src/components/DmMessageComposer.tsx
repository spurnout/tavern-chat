import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Dice5, Paperclip, Send, X } from 'lucide-react';
import {
  ALLOWED_AUDIO_MIMES,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  UPLOAD_LIMITS,
  type Attachment,
  type Message,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { uploadFile } from '../lib/uploads.js';
import { filesFromClipboard } from '../lib/clipboard-files.js';

interface Props {
  dmChannelId: string;
}

const DICE_PREFIX = '/roll ';

interface PendingAttachment {
  attachment: Attachment;
  previewUrl?: string;
}

/**
 * DM composer — same feature surface as the server composer (text, dice
 * via `/roll`, multi-file attachments) minus the typing indicator and
 * voice-message recorder. Voice messages in DMs can be layered later
 * without changing this component.
 */
export function DmMessageComposer({ dmChannelId }: Props): JSX.Element {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function send(): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed && pending.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      if (trimmed.startsWith(DICE_PREFIX) && pending.length === 0) {
        const notation = trimmed.slice(DICE_PREFIX.length).trim();
        await api('/dice/roll', {
          method: 'POST',
          body: { dmChannelId, notation, visibility: 'public' },
        });
      } else {
        await api<Message>(`/dms/${dmChannelId}/messages`, {
          method: 'POST',
          body: {
            content: trimmed,
            attachmentIds: pending.map((p) => p.attachment.id),
            nonce: cryptoRandomNonce(),
          },
        });
      }
      setContent('');
      for (const p of pending) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      }
      setPending([]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to send';
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function onFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    await ingestFiles(files);
  }

  // Pasting an image (screenshot, copied picture) or file drops it straight
  // into the composer as a pending attachment, the same as the file picker.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = filesFromClipboard(e.clipboardData);
    if (files.length === 0) return; // plain-text paste — let the textarea handle it
    e.preventDefault();
    void ingestFiles(files);
  }

  async function ingestFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const sizeLimit = pickSizeLimitFor(file.type);
      if (file.size > sizeLimit) {
        toast.error(
          `${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${(sizeLimit / 1024 / 1024).toFixed(0)} MB.`,
        );
        continue;
      }
      if (file.type === 'image/svg+xml') {
        toast.error('SVG uploads are blocked for security reasons.');
        continue;
      }
      try {
        // DM attachments are created without a channel/server association;
        // they're claimed by the DM message at send time. The upload route
        // permits this — attachments are first-class until they're claimed.
        const att = await uploadFile({ file });
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPending((p) => [...p, { attachment: att, previewUrl }]);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Upload failed';
        toast.error(msg);
      }
    }
  }

  function pickSizeLimitFor(mime: string): number {
    if ((ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
      return UPLOAD_LIMITS.MAX_IMAGE_BYTES;
    }
    if ((ALLOWED_VIDEO_MIMES as readonly string[]).includes(mime)) {
      return UPLOAD_LIMITS.MAX_VIDEO_BYTES;
    }
    if ((ALLOWED_AUDIO_MIMES as readonly string[]).includes(mime)) {
      return UPLOAD_LIMITS.MAX_AUDIO_BYTES;
    }
    return UPLOAD_LIMITS.MAX_GENERIC_FILE_BYTES;
  }

  function removePending(id: string): void {
    const target = pending.find((x) => x.attachment.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    setPending((p) => p.filter((x) => x.attachment.id !== id));
  }

  return (
    <div className="border-t border-subtle bg-sunken p-3">
      {error ? <div className="mb-2 text-xs text-danger">{error}</div> : null}
      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.attachment.id}
              className="relative rounded border border-subtle bg-surface p-1 pr-7 text-xs"
            >
              {p.previewUrl ? (
                <img src={p.previewUrl} alt="" className="h-12 w-12 rounded object-cover" />
              ) : (
                <div className="px-2 py-1.5 font-mono">{p.attachment.filename}</div>
              )}
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => removePending(p.attachment.id)}
                className="absolute right-1 top-1 rounded p-0.5 text-fg-muted hover:bg-raised"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label="Attach file"
          onClick={() => fileRef.current?.click()}
          className="rounded p-2 text-fg-muted hover:bg-raised"
          title="Attach a file"
        >
          <Paperclip size={16} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void onFileChange(e)}
        />
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          className="min-h-[40px] max-h-40 flex-1 resize-none rounded border border-subtle bg-canvas px-3 py-2 text-sm text-fg focus:outline-none focus:ring-1 focus:ring-ember"
          placeholder={`Message (${DICE_PREFIX}1d20 to roll)`}
        />
        <button
          type="button"
          aria-label="Send message"
          disabled={busy}
          onClick={() => void send()}
          className="rounded bg-ember p-2 text-fg-on-accent hover:bg-ember-hi disabled:opacity-50"
        >
          {content.trim().startsWith(DICE_PREFIX) ? <Dice5 size={16} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}

function cryptoRandomNonce(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
