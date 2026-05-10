import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
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

  // Tracks whether the component is still mounted so async callbacks (recorder
  // onstop, upload completions) can skip setState on a teardown.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  // Typing indicator — at most one ping per ~3 seconds.
  const lastTypingRef = useRef(0);
  function onContentChange(value: string): void {
    setContent(value);
    const now = Date.now();
    if (now - lastTypingRef.current > 3000 && value.length > 0) {
      lastTypingRef.current = now;
      api(`/channels/${channelId}/typing`, { method: 'POST' }).catch(() => undefined);
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
    const target = pending.find((x) => x.attachment.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    setPending((p) => p.filter((x) => x.attachment.id !== id));
  }

  async function startRecording(): Promise<void> {
    if (recording) return;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // MediaRecorder construction can throw (e.g. Safari rejects audio/webm).
      // Capture the stream above so the catch below can stop its tracks.
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      const recorderStream = stream;
      recordingChunks.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordingChunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        for (const t of recorderStream.getTracks()) t.stop();
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
          if (!mountedRef.current) {
            // Component unmounted before the upload resolved — surface the
            // failure to the console so it isn't completely invisible.
            console.warn('[voice] upload failed after composer unmount:', err);
            return;
          }
          const msg = err instanceof ApiError ? err.message : 'Voice message failed';
          setError(msg);
        }
      };
      recorder.start();
      setRecording(recorder);
    } catch (err) {
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
      }
      const msg = err instanceof Error ? err.message : 'Could not access microphone';
      setError(msg);
    }
  }

  function stopRecording(): void {
    if (recording) {
      recording.stop();
      setRecording(null);
    }
  }

  return (
    <div className="border-t border-subtle bg-sunken p-3">
      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.attachment.id}
              className="relative flex items-center gap-2 rounded border border-subtle bg-canvas px-2 py-1 text-xs"
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
                className="rounded p-1 hover:bg-raised"
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
          onChange={(e) => onContentChange(e.target.value)}
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
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      {recording ? (
        <p className="mt-1 text-xs text-mead">● Recording… click stop to send</p>
      ) : null}
    </div>
  );
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
