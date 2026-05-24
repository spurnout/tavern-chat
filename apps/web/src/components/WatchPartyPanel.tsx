import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Tv, X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface WatchParty {
  id: string;
  channelId: string;
  hostUserId: string;
  videoUrl: string;
  source: string;
  startedAt: string;
  currentSec: number;
  isPlaying: boolean;
  lastUpdatedAt: string;
}

interface Props {
  channelId: string;
  /** Caller's user id, so we know whether they're the host. */
  userId: string;
}

/**
 * Wave 3 #26 — watch parties.
 *
 * Renders the active party for a voice channel. The host sees real controls
 * and sends a PATCH on play/pause/seek; viewers see a read-only video that
 * follows the host's broadcast state.
 *
 * The drift correction is intentionally coarse: when a state update lands,
 * viewers snap to (currentSec + elapsed-since-lastUpdatedAt) if they're
 * more than 1.5 seconds off. Anything tighter starts thrashing on jittery
 * networks; anything looser feels out of sync.
 *
 * MP4 only in V1. The `source: 'youtube'` slot is wired in the API but the
 * iframe-API control surface lives in a follow-up.
 */
export function WatchPartyPanel({ channelId, userId }: Props): JSX.Element | null {
  const [party, setParty] = useState<WatchParty | null>(null);
  const [loading, setLoading] = useState(true);
  const [urlDraft, setUrlDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<WatchParty | null>(`/voice/${channelId}/watch-party`);
      setParty(r);
    } catch {
      // Section still renders.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // Listen for WATCH_PARTY_* gateway events. We piggy-back on the same
    // broker store dispatch path the rest of the app uses by polling every
    // 5s as a fallback — the gateway-driven update arrives faster but the
    // poll keeps late joiners honest. PERF: only poll while a party is
    // actually loaded (or until we know there isn't one). For the common
    // case (no party in this room) the post-first-load `party === null`
    // state stops the interval, so a quiet voice room isn't hitting the
    // API every 5s for the entire session.
    if (party === null) return;
    const handle = window.setInterval(refresh, 5000);
    return () => window.clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, party === null]);

  const isHost = !!party && party.hostUserId === userId;

  // Sync viewer position to host state. Skip when local user is the host —
  // their own playback IS the truth.
  useEffect(() => {
    if (!party || isHost) return;
    const v = videoRef.current;
    if (!v) return;
    const elapsedSec = (Date.now() - new Date(party.lastUpdatedAt).getTime()) / 1000;
    const targetSec = party.isPlaying ? party.currentSec + elapsedSec : party.currentSec;
    if (Math.abs(v.currentTime - targetSec) > 1.5) {
      v.currentTime = targetSec;
    }
    if (party.isPlaying && v.paused) {
      v.play().catch(() => undefined);
    } else if (!party.isPlaying && !v.paused) {
      v.pause();
    }
  }, [party, isHost]);

  async function start(): Promise<void> {
    if (!urlDraft.trim()) {
      toast.error('Paste a video URL first.');
      return;
    }
    setBusy(true);
    try {
      // Inferring source from URL: youtube.com / youtu.be → youtube,
      // anything else → mp4. The API accepts hls/twitch/other too but the
      // UI only renders mp4 in V1.
      const source = /youtu\.?be/.test(urlDraft) ? 'youtube' : 'mp4';
      await api(`/voice/${channelId}/watch-party`, {
        method: 'POST',
        body: { videoUrl: urlDraft.trim(), source },
      });
      setUrlDraft('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start the party');
    } finally {
      setBusy(false);
    }
  }

  async function pushState(currentSec: number, isPlaying: boolean): Promise<void> {
    if (!party) return;
    try {
      const updated = await api<WatchParty>(`/watch-party/${party.id}`, {
        method: 'PATCH',
        body: { currentSec, isPlaying },
      });
      setParty(updated);
    } catch (err) {
      // Don't toast on every blip — playback events can fire fast.
      if (err instanceof ApiError && err.status >= 500) {
        toast.error('Could not sync playback');
      }
    }
  }

  async function end(): Promise<void> {
    if (!party) return;
    setBusy(true);
    try {
      await api(`/watch-party/${party.id}`, { method: 'DELETE' });
      setParty(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not end the party');
    } finally {
      setBusy(false);
    }
  }

  async function takeover(): Promise<void> {
    if (!party) return;
    try {
      const updated = await api<WatchParty>(`/watch-party/${party.id}/takeover`, {
        method: 'POST',
        body: {},
      });
      setParty(updated);
      toast.info('You are now the host.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not take over');
    }
  }

  if (loading) return null;

  if (!party) {
    return (
      <section className="rounded border border-subtle bg-surface p-3 text-sm">
        <header className="mb-2 flex items-center gap-2">
          <Tv size={14} className="text-fg-muted" />
          <h3 className="font-serif">Watch party</h3>
        </header>
        <div className="flex flex-wrap gap-2">
          <input
            className="input flex-1"
            type="url"
            placeholder="Paste an MP4 URL (or YouTube link — beta)"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void start()}
            disabled={busy || !urlDraft.trim()}
          >
            Start
          </button>
        </div>
      </section>
    );
  }

  const isYouTube = party.source === 'youtube';
  return (
    <section className="rounded border border-mead/60 bg-surface p-3 text-sm">
      <header className="mb-2 flex items-center gap-2">
        <Tv size={14} className="text-mead" />
        <h3 className="font-serif">Watch party</h3>
        <span className="text-xs text-fg-muted">
          {isHost ? '(you are the host)' : `host: ${party.hostUserId.slice(0, 6)}…`}
        </span>
        {!isHost ? (
          <button
            type="button"
            className="ml-auto btn-ghost text-xs"
            onClick={() => void takeover()}
          >
            Take over
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void end()}
          className={`${isHost ? '' : 'ml-auto'} rounded p-1 text-fg-muted hover:bg-raised`}
          aria-label="End party"
          title="End party"
          disabled={busy}
        >
          <X size={14} />
        </button>
      </header>
      {isYouTube ? (
        <div className="grid place-items-center rounded bg-canvas p-4 text-xs text-fg-muted">
          YouTube embeds are a follow-up — the link is{' '}
          <a className="text-mead underline" href={party.videoUrl} target="_blank" rel="noreferrer">
            here
          </a>
          .
        </div>
      ) : (
        <video
          ref={videoRef}
          src={party.videoUrl}
          controls={isHost}
          className="aspect-video w-full rounded bg-black"
          onPlay={() => {
            if (isHost && videoRef.current) {
              void pushState(videoRef.current.currentTime, true);
            }
          }}
          onPause={() => {
            if (isHost && videoRef.current) {
              void pushState(videoRef.current.currentTime, false);
            }
          }}
          onSeeked={() => {
            if (isHost && videoRef.current) {
              void pushState(videoRef.current.currentTime, !videoRef.current.paused);
            }
          }}
        />
      )}
      {!isHost ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
          {party.isPlaying ? <Play size={12} /> : <Pause size={12} />}
          <span>Synced to host</span>
        </div>
      ) : null}
    </section>
  );
}
