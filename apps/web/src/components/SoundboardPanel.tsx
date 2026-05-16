import { useEffect, useRef, useState } from 'react';
import { Music, Play, Repeat, Square, Trash2, Upload, X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { uploadFile } from '../lib/uploads.js';

interface Clip {
  id: string;
  serverId: string;
  name: string;
  attachmentId: string;
  color: string | null;
  position: number;
  isAmbient: boolean;
  addedBy: string;
  createdAt: string;
}

interface Props {
  serverId: string;
  /** Voice channel to cue clips into. Required to actually trigger the cue. */
  voiceChannelId: string;
  onClose: () => void;
}

export function SoundboardPanel({ serverId, voiceChannelId, onClose }: Props): JSX.Element {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  // Local "this user has started this ambient pad" tracking. Doesn't sync
  // across users — another player stopping it won't flip our toggle — but
  // that's acceptable for a polish surface.
  const [playingAmbient, setPlayingAmbient] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<Clip[]>(`/servers/${serverId}/soundboard`);
      setClips(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not load soundboard');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [serverId]);

  async function play(clip: Clip): Promise<void> {
    try {
      await api(`/voice/${voiceChannelId}/soundboard`, {
        method: 'POST',
        body: { clipId: clip.id, loop: clip.isAmbient },
      });
      if (clip.isAmbient) {
        setPlayingAmbient((s) => new Set(s).add(clip.id));
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not cue clip');
    }
  }

  async function stop(clip: Clip): Promise<void> {
    try {
      await api(`/voice/${voiceChannelId}/soundboard/stop`, {
        method: 'POST',
        body: { clipId: clip.id },
      });
      setPlayingAmbient((s) => {
        const n = new Set(s);
        n.delete(clip.id);
        return n;
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not stop clip');
    }
  }

  async function toggleAmbientFlag(clip: Clip): Promise<void> {
    try {
      const updated = await api<Clip>(`/soundboard/${clip.id}`, {
        method: 'PATCH',
        body: { isAmbient: !clip.isAmbient },
      });
      setClips((s) => s.map((c) => (c.id === updated.id ? updated : c)));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update clip');
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/soundboard/${id}`, { method: 'DELETE' });
      setClips((s) => s.filter((c) => c.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove');
    }
  }

  async function onFile(file: File): Promise<void> {
    setUploading(true);
    try {
      const att = await uploadFile({ file, serverId, kind: 'audio' });
      const name = file.name.replace(/\.[^.]+$/, '');
      await api(`/servers/${serverId}/soundboard`, {
        method: 'POST',
        body: { name, attachmentId: att.id },
      });
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 rounded border border-subtle bg-surface p-3 shadow-lg">
      <header className="mb-2 flex items-center gap-2">
        <Music size={14} />
        <h2 className="font-serif text-sm">Soundboard</h2>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="ml-auto rounded p-1 hover:bg-raised"
          title="Upload clip"
          aria-label="Upload clip"
          disabled={uploading}
        >
          <Upload size={14} />
        </button>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-raised" aria-label="Close">
          <X size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onFile(f);
          }}
        />
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {loading ? (
          <p className="col-span-full text-fg-muted">Loading…</p>
        ) : clips.length === 0 ? (
          <p className="col-span-full text-fg-muted">
            No clips yet. Upload an audio file to the tavern soundboard.
          </p>
        ) : (
          clips.map((c) => {
            const playing = c.isAmbient && playingAmbient.has(c.id);
            return (
              <div
                key={c.id}
                className={`group relative rounded border bg-canvas p-2 ${
                  c.isAmbient ? 'border-mead/60' : 'border-subtle'
                } ${playing ? 'ring-1 ring-ember' : ''}`}
                style={c.color ? { borderColor: c.color } : undefined}
              >
                <button
                  type="button"
                  onClick={() => void (playing ? stop(c) : play(c))}
                  className="flex w-full items-center gap-2 text-left text-sm"
                  title={playing ? 'Stop loop' : c.isAmbient ? 'Start loop' : 'Play'}
                >
                  {playing ? (
                    <Square size={12} className="text-ember" />
                  ) : c.isAmbient ? (
                    <Repeat size={12} className="text-mead" />
                  ) : (
                    <Play size={12} className="text-mead" />
                  )}
                  <span className="truncate">{c.name}</span>
                </button>
                <div className="absolute right-1 top-1 hidden items-center gap-1 group-hover:flex">
                  <button
                    type="button"
                    onClick={() => void toggleAmbientFlag(c)}
                    className={`rounded p-1 hover:bg-raised ${
                      c.isAmbient ? 'text-mead' : 'text-fg-muted'
                    }`}
                    title={c.isAmbient ? 'Mark as one-shot SFX' : 'Mark as ambient loop'}
                    aria-label={c.isAmbient ? 'Mark as one-shot' : 'Mark as ambient'}
                  >
                    <Repeat size={10} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(c.id)}
                    className="rounded p-1 text-fg-muted hover:bg-raised"
                    aria-label="Remove"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {uploading ? <p className="mt-2 text-xs text-fg-muted">Uploading…</p> : null}
      <SoundboardCueListener voiceChannelId={voiceChannelId} />
    </div>
  );
}

// Listens for SOUNDBOARD_CUE events on the active voice channel and plays
// the audio locally. The event payload carries an attachmentId; we resolve
// that to a URL via the attachments API.
function SoundboardCueListener({ voiceChannelId: _voiceChannelId }: { voiceChannelId: string }): null {
  // The realtime layer routes SOUNDBOARD_CUE events by channelId; the actual
  // wiring lives in lib/realtime.ts (added in the same wave). This component
  // is a placeholder so future per-user playback preferences can sit here.
  return null;
}
