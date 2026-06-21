import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Dice5, Mic, Paperclip, Plus, Send, Smile, Square, X } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ALLOWED_AUDIO_MIMES,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_VIDEO_MIMES,
  parseSlashInput,
  UPLOAD_LIMITS,
  type Attachment,
  type Message,
  type SlashExecuteResponse,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useRealtime } from '../lib/store.js';
import { toast } from '../lib/toast.js';
import { uploadFile, type UploadProgress, type UploadStrategyInfo } from '../lib/uploads.js';
import { filesFromClipboard } from '../lib/clipboard-files.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { MentionAutocomplete } from './MentionAutocomplete.js';
import { EmojiPicker } from './EmojiPicker.js';
import { CreatePollModal } from './CreatePollModal.js';
import { RemindModal } from './RemindModal.js';
import { ErrorAlert } from './ErrorAlert.js';

// Shared className for the composer's "+" overflow-menu items (3.3).
const COMPOSER_MENU_ITEM =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-2 outline-none data-[highlighted]:bg-raised';

interface Props {
  channelId: string;
}

interface PendingAttachment {
  attachment: Attachment;
  previewUrl?: string;
}

interface UploadStatus {
  filename: string;
  loaded: number;
  total: number;
  voiceActive: boolean;
  maxBytesPerSecond?: number;
}

export function MessageComposer({ channelId }: Props): JSX.Element {
  const setComposerDraft = useRealtime((s) => s.setComposerDraft);
  const clearPendingMention = useRealtime((s) => s.clearPendingMention);
  const pendingMention = useRealtime((s) => s.pendingMentionByChannelId[channelId] ?? null);

  const [content, setContent] = useState(
    () => useRealtime.getState().composerDraftByChannelId[channelId] ?? '',
  );
  const [cursorOffset, setCursorOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pollModal, setPollModal] = useState<{ question?: string; options?: string[] } | null>(null);
  const [remindModal, setRemindModal] = useState<{ text?: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const composerHelpId = useId();

  function insertAtCursor(text: string): void {
    setContent((prev) => {
      const head = prev.slice(0, cursorOffset);
      const tail = prev.slice(cursorOffset);
      const next = `${head}${text}${tail}`;
      setComposerDraft(channelId, next);
      const newCursor = cursorOffset + text.length;
      queueMicrotask(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newCursor, newCursor);
          setCursorOffset(newCursor);
        }
      });
      return next;
    });
  }

  // When the user switches rooms, swap the composer to that room's draft.
  // Drafts survive across navigations so half-written messages aren't lost.
  useEffect(() => {
    setContent(useRealtime.getState().composerDraftByChannelId[channelId] ?? '');
  }, [channelId]);

  // The member profile card writes here when "Mention in this room" is
  // clicked. We append `@displayName ` to the current draft, focus the
  // textarea, and clear the slot so the same mention isn't re-applied.
  useEffect(() => {
    if (!pendingMention) return;
    setContent((prev) => {
      const sep = prev.length === 0 || prev.endsWith(' ') ? '' : ' ';
      const next = `${prev}${sep}@${pendingMention} `;
      setComposerDraft(channelId, next);
      return next;
    });
    clearPendingMention(channelId);
    // Defer focus until after the textarea has the new value.
    queueMicrotask(() => {
      textareaRef.current?.focus();
      const el = textareaRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [pendingMention, channelId, clearPendingMention, setComposerDraft]);

  // Tracks whether the component is still mounted so async callbacks (recorder
  // onstop, upload completions) can skip setState on a teardown.
  const mountedRef = useRef(true);
  // FE-06: hold the active MediaRecorder + its stream in refs so the unmount
  // cleanup can tear them down. The state copy is the source of truth for
  // rendering; the refs are the source of truth for cleanup, because they
  // survive the React-render that nulls out the state value.
  const activeRecorderRef = useRef<MediaRecorder | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  // FE-06b: capture the latest `pending` array in a ref so the unmount
  // cleanup can revoke every object URL it created. The setState reference
  // we'd otherwise hold in closure is stale by the time the effect runs.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // FE-06: if the user closed the tab / navigated away mid-recording, the
      // browser would otherwise leave the mic indicator lit indefinitely.
      // Tear down both the recorder and its media tracks.
      const rec = activeRecorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      const s = activeStreamRef.current;
      if (s) {
        for (const t of s.getTracks()) {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
      }
      activeRecorderRef.current = null;
      activeStreamRef.current = null;
      // FE-06b: revoke every preview blob URL on unmount. send() and
      // removePending() handle the steady state; this catches the
      // navigate-away-without-sending path.
      for (const p of pendingRef.current) {
        if (p.previewUrl) {
          try {
            URL.revokeObjectURL(p.previewUrl);
          } catch {
            /* ignore */
          }
        }
      }
    };
  }, []);

  async function send(): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed && pending.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const slash = parseSlashInput(trimmed);
      if (slash && pending.length === 0) {
        // Client-action commands open a modal instead of POSTing to the
        // server. `/poll question | a | b | c` pre-fills the modal so the
        // typed args aren't wasted.
        if (slash.command === 'poll') {
          const segments = slash.args
            .split('|')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const question = segments[0] ?? '';
          const options = segments.slice(1);
          setPollModal({
            question,
            options: options.length >= 2 ? options : ['', ''],
          });
          setContent('');
          setComposerDraft(channelId, '');
          return;
        }
        if (slash.command === 'remind') {
          setRemindModal({ text: slash.args });
          setContent('');
          setComposerDraft(channelId, '');
          return;
        }
        await api<SlashExecuteResponse>(`/channels/${channelId}/slash`, {
          method: 'POST',
          body: {
            command: slash.command,
            args: slash.args,
            nonce: cryptoRandomNonce(),
          },
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
      setComposerDraft(channelId, '');
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

  // Typing indicator — at most one ping per ~3 seconds.
  const lastTypingRef = useRef(0);
  function onContentChange(value: string): void {
    setContent(value);
    setComposerDraft(channelId, value);
    const now = Date.now();
    if (now - lastTypingRef.current > 3000 && value.length > 0) {
      lastTypingRef.current = now;
      api(`/channels/${channelId}/typing`, { method: 'POST' }).catch(() => undefined);
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
      // FE-24: validate size and MIME type client-side before burning an
      // upload slot. The server is still authoritative — these mirror the
      // server's UploadValidator allow-lists in packages/shared/constants.ts
      // so a malicious client can't bypass them.
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
        const att = await uploadWithComposerStatus(file);
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

  async function uploadWithComposerStatus(
    file: File,
    kind?: Attachment['kind'],
  ): Promise<Attachment> {
    if (mountedRef.current) {
      setUploadStatus({ filename: file.name, loaded: 0, total: file.size, voiceActive: false });
    }
    const onProgress = (progress: UploadProgress) => {
      if (!mountedRef.current) return;
      setUploadStatus((current) =>
        current?.filename === file.name ? { ...current, ...progress } : current,
      );
    };
    const onStrategy = (strategy: UploadStrategyInfo) => {
      if (!mountedRef.current) return;
      setUploadStatus((current) => ({
        filename: file.name,
        loaded: current?.filename === file.name ? current.loaded : 0,
        total: file.size,
        voiceActive: strategy.strategy === 'tavern_throttled' || strategy.voiceActive === true,
        maxBytesPerSecond: strategy.maxBytesPerSecond,
      }));
    };

    try {
      return await uploadFile({ file, channelId, ...(kind ? { kind } : {}) }, onProgress, onStrategy);
    } finally {
      if (mountedRef.current) setUploadStatus(null);
    }
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
        activeRecorderRef.current = null;
        activeStreamRef.current = null;
        const blob = new Blob(recordingChunks.current, { type: 'audio/webm' });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        try {
          const att = await uploadWithComposerStatus(file, 'voice_message');
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
          toast.error(msg);
        }
      };
      activeRecorderRef.current = recorder;
      activeStreamRef.current = recorderStream;
      recorder.start();
      setRecording(recorder);
    } catch (err) {
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
      }
      const msg = err instanceof Error ? err.message : 'Could not access microphone';
      toast.error(msg);
    }
  }

  function stopRecording(): void {
    if (recording) {
      recording.stop();
      setRecording(null);
    }
  }

  return (
    <div className="border-t border-subtle bg-sunken px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      {/* Centre the composer's content on the same 880px column the message
          list uses; the border/background still span full width. */}
      <div className="mx-auto w-full max-w-[880px]">
      <SlashAutocomplete
        channelId={channelId}
        text={content}
        onAccept={(next) => {
          setContent(next);
          setComposerDraft(channelId, next);
          queueMicrotask(() => {
            textareaRef.current?.focus();
            const el = textareaRef.current;
            if (el) el.setSelectionRange(el.value.length, el.value.length);
          });
        }}
        onDismiss={() => {
          // Clearing the leading `/` collapses the popover; tab key gives
          // the user a hard close path without losing typed text.
        }}
      />
      <MentionAutocomplete
        channelId={channelId}
        text={content}
        cursorOffset={cursorOffset}
        onAccept={(next, caret) => {
          setContent(next);
          setComposerDraft(channelId, next);
          setCursorOffset(caret);
          queueMicrotask(() => {
            const el = textareaRef.current;
            if (el) {
              el.focus();
              el.setSelectionRange(caret, caret);
            }
          });
        }}
      />
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
      {uploadStatus ? (
        <div
          className="mb-2 rounded border border-subtle bg-canvas px-3 py-2 text-xs text-fg-muted"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-fg">
              Uploading {uploadStatus.filename}
              {uploadStatus.total > 0
                ? ` ${Math.min(100, Math.round((uploadStatus.loaded / uploadStatus.total) * 100))}%`
                : ''}
            </span>
            {uploadStatus.voiceActive ? (
              <span className="text-ember">
                Voice room active: uploads are slowed to protect call quality
                {uploadStatus.maxBytesPerSecond
                  ? ` (${formatBytesPerSecond(uploadStatus.maxBytesPerSecond)})`
                  : ''}
                .
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="composer-cq flex items-end gap-2">
        <input
          type="file"
          multiple
          ref={fileRef}
          className="hidden"
          onChange={(e) => void onFileChange(e)}
          aria-label="Attach files"
        />
        {/* Narrow-container overflow: collapse the secondary affordances into a
            single "+" menu so the textarea keeps a usable width. */}
        <div className="composer-actions-overflow shrink-0">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="btn-ghost shrink-0 touch-target-sq"
                aria-label="More actions"
                disabled={busy}
              >
                <Plus size={18} aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                className="z-40 min-w-[11rem] rounded-md border border-subtle bg-surface p-1 text-sm text-fg shadow-lg"
              >
                <DropdownMenu.Item
                  className={COMPOSER_MENU_ITEM}
                  onSelect={() => fileRef.current?.click()}
                >
                  <Paperclip size={14} aria-hidden /> Attach files
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={COMPOSER_MENU_ITEM}
                  onSelect={() =>
                    setContent((c) => {
                      const next = c ? c : '/roll 1d20';
                      setComposerDraft(channelId, next);
                      return next;
                    })
                  }
                >
                  <Dice5 size={14} aria-hidden /> Roll dice
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={COMPOSER_MENU_ITEM}
                  onSelect={() => (recording ? stopRecording() : void startRecording())}
                >
                  <Mic size={14} aria-hidden /> {recording ? 'Stop recording' : 'Record voice'}
                </DropdownMenu.Item>
                <DropdownMenu.Item className={COMPOSER_MENU_ITEM} onSelect={() => setEmojiOpen(true)}>
                  <Smile size={14} aria-hidden /> Emoji
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {/* Inline affordances — shown when the composer is wide enough. */}
        <div className="composer-actions-inline items-end gap-2">
          <button
            type="button"
            className="btn-ghost shrink-0 touch-target-sq"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <Paperclip size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="btn-ghost shrink-0 touch-target-sq"
            aria-label="Roll dice"
            title="Roll dice (try /roll 1d20+5)"
            onClick={() =>
              setContent((c) => {
                const next = c ? c : '/roll 1d20';
                setComposerDraft(channelId, next);
                return next;
              })
            }
            disabled={busy}
          >
            <Dice5 size={18} aria-hidden />
          </button>
          <button
            type="button"
            className={
              recording
                ? 'btn-primary shrink-0 touch-target-sq'
                : 'btn-ghost shrink-0 touch-target-sq'
            }
            aria-label={recording ? 'Stop recording' : 'Record voice message'}
            title={recording ? 'Stop recording' : 'Record voice message'}
            onClick={() => (recording ? stopRecording() : void startRecording())}
            disabled={busy}
          >
            {recording ? <Square size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
          </button>
        </div>
        {/* Emoji wrapper stays mounted so the picker keeps an anchor in both
            modes; only the Smile button collapses. */}
        <div className="relative shrink-0">
          <button
            type="button"
            className="composer-actions-inline btn-ghost touch-target-sq"
            aria-label="Insert emoji"
            title="Insert emoji"
            onClick={() => setEmojiOpen((v) => !v)}
            disabled={busy}
          >
            <Smile size={18} aria-hidden />
          </button>
          {emojiOpen ? (
            <div className="absolute bottom-full right-0 mb-2">
              <EmojiPicker
                open={emojiOpen}
                onClose={() => setEmojiOpen(false)}
                onPick={(emoji) => {
                  insertAtCursor(emoji);
                  setEmojiOpen(false);
                }}
              />
            </div>
          ) : null}
        </div>
        <textarea
          ref={textareaRef}
          className="input min-h-[2.5rem] flex-1 resize-none"
          value={content}
          onChange={(e) => {
            onContentChange(e.target.value);
            setCursorOffset(e.target.selectionStart);
          }}
          onKeyUp={(e) => setCursorOffset(e.currentTarget.selectionStart)}
          onClick={(e) => setCursorOffset(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
          aria-describedby={composerHelpId}
          placeholder="Message this room"
          rows={1}
        />
        <button
          type="button"
          className="btn-primary shrink-0 touch-target-sq"
          disabled={busy || (!content.trim() && pending.length === 0)}
          onClick={() => void send()}
          aria-label="Send"
        >
          <Send size={16} aria-hidden />
        </button>
      </div>
      <p id={composerHelpId} className="mt-2 text-xs text-fg-muted">
        Press Shift+Enter for a new line. Try /roll 1d20+5 for dice or @ to mention someone.
      </p>
      {error ? <ErrorAlert className="mt-2 text-xs">{error}</ErrorAlert> : null}
      {recording ? (
        <p className="mt-1 text-xs text-mead">● Recording… click stop to send</p>
      ) : null}
      {pollModal ? (
        <CreatePollModal
          channelId={channelId}
          initialQuestion={pollModal.question ?? ''}
          initialOptions={pollModal.options ?? ['', '']}
          onClose={() => setPollModal(null)}
        />
      ) : null}
      {remindModal ? (
        <RemindModal initialText={remindModal.text} onClose={() => setRemindModal(null)} />
      ) : null}
      </div>
    </div>
  );
}

function cryptoRandomNonce(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function formatBytesPerSecond(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB/s`;
  return `${Math.round(bytes / 1024)} KiB/s`;
}
