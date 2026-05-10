import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Dice5, Mic, Paperclip, Send, Square, X } from 'lucide-react';
import type { Attachment, Message } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { uploadFile } from '../lib/uploads.js';

interface Props {
  channelId: string;
}

const DICE_PREFIX = '/roll ';

interface PendingAttachment {
  attachment: Attachment;
  previewUrl?: string;
}

export function MessageComposer({ channelId }: Props): JSX.Element {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recordingChunks = useRef<Blob[]>([]);

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
          body: { channelId, notation, visibility: 'public' },
        });
      } else {
        await api<Message>(`/channels/${channelId}/messages`, {
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
      textareaRef.current?.focus();
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
    for (const file of files) {
      try {
        const att = await uploadFile({ file, channelId });
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPending((p) => [...p, { attachment: att, previewUrl }]);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : 'Upload failed';
        setError(msg);
      }
    }
  }

  function removePending(id: string): void {
    setPending((p) => {
      const removed = p.find((x) => x.attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return p.filter((x) => x.attachment.id !== id);
    });
  }

  async function startRecording(): Promise<void> {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      recordingChunks.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordingChunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        const blob = new Blob(recordingChunks.current, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        try {
          const att = await uploadFile({ file, channelId, kind: 'voice_message' });
          await api(`/channels/${channelId}/messages`, {
            method: 'POST',
            body: {
              content: '',
              attachmentIds: [att.id],
              nonce: cryptoRandomNonce(),
            },
          });
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : 'Voice message failed';
          setError(msg);
        }
      };
      recorder.start();
      setRecording(recorder);
    } catch {
      setError('Could not access microphone');
    }
  }

  function stopRecording(): void {
    if (recording) {
      recording.stop();
      setRecording(null);
    }
  }

  return (
    <div className="border-t border-tavern-oak bg-tavern-stone p-3">
      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.attachment.id}
              className="relative flex items-center gap-2 rounded border border-tavern-oak bg-tavern-ink px-2 py-1 text-xs"
            >
              {p.previewUrl ? (
                <img
                  src={p.previewUrl}
                  alt={p.attachment.filename}
                  className="h-12 w-12 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} />
              )}
              <span className="max-w-[12rem] truncate">{p.attachment.filename}</span>
              <button
                type="button"
                onClick={() => removePending(p.attachment.id)}
                className="rounded p-1 hover:bg-tavern-oak"
                aria-label="Remove attachment"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <input
          type="file"
          multiple
          ref={fileRef}
          className="hidden"
          onChange={(e) => void onFileChange(e)}
        />
        <button
          type="button"
          className="btn-ghost shrink-0"
          title="Attach files"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          <Paperclip size={18} />
        </button>
        <button
          type="button"
          className="btn-ghost shrink-0"
          title="Roll dice (try /roll 1d20+5)"
          onClick={() => setContent((c) => (c ? c : `${DICE_PREFIX}1d20`))}
          disabled={busy}
        >
          <Dice5 size={18} />
        </button>
        <button
          type="button"
          className={recording ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
          title={recording ? 'Stop recording' : 'Record voice message'}
          onClick={() => (recording ? stopRecording() : void startRecording())}
          disabled={busy}
        >
          {recording ? <Square size={18} /> : <Mic size={18} />}
        </button>
        <textarea
          ref={textareaRef}
          className="input min-h-[2.5rem] flex-1 resize-none"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message — Shift+Enter for newline. /roll 1d20+5 to roll dice."
          disabled={busy}
          rows={1}
        />
        <button
          type="button"
          className="btn-primary shrink-0"
          disabled={busy || (!content.trim() && pending.length === 0)}
          onClick={() => void send()}
          aria-label="Send"
        >
          <Send size={16} />
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
      {recording ? (
        <p className="mt-1 text-xs text-tavern-mead">● Recording… click stop to send</p>
      ) : null}
    </div>
  );
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
