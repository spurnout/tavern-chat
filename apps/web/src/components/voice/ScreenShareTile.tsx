import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalParticipant, RemoteParticipant, TrackPublication } from 'livekit-client';
import { Maximize2, Minimize2, Pin, PinOff } from 'lucide-react';

type ParticipantAny = LocalParticipant | RemoteParticipant;

export interface ScreenShareTileProps {
  participant: ParticipantAny;
  publication: TrackPublication;
  isPinned: boolean;
  onTogglePin: () => void;
}

export function ScreenShareTile({
  participant,
  publication,
  isPinned,
  onTogglePin,
}: ScreenShareTileProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Depend on `publication.track` rather than the publication object so a
  // post-reconnect track replacement still re-attaches the live stream.
  const track = publication.track;
  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    try {
      track.attach(el);
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn('[voice] screen-share track.attach failed', err);
      }
    }
    // Chrome on Windows leaves the local getDisplayMedia preview in an
    // "attached but rendering all-black" state if the first capture frame
    // arrives after the element has already painted. `track.attach()`
    // already set srcObject; re-wrapping the same MediaStreamTrack in a
    // fresh MediaStream forces the element to re-initialise its rendering
    // pipeline, which consistently breaks Chrome out of the stuck state.
    // The explicit play() is belt-and-suspenders on top of `autoPlay` —
    // the AbortError if any is swallowed by the catch.
    const mst = track.mediaStreamTrack;
    if (mst) {
      el.srcObject = new MediaStream([mst]);
    }
    void el.play().catch(() => {
      // Autoplay can be rejected without a recent user gesture; starting
      // a screen-share is itself a gesture so this should not fire.
    });
    if (import.meta.env.DEV) {
      console.info('[voice] screen-share attached', {
        isLocal: participant.isLocal,
        readyState: mst?.readyState,
        muted: mst?.muted,
        enabled: mst?.enabled,
        kind: mst?.kind,
      });
    }
    return () => {
      track.detach(el);
    };
  }, [track, participant.isLocal]);

  useEffect(() => {
    const onChange = (): void => {
      setFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        // Safari ships a prefixed variant that TS doesn't model.
        const req = (el as HTMLDivElement & { webkitRequestFullscreen?: () => Promise<void> })
          .webkitRequestFullscreen;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (req) await req.call(el);
      }
    } catch {
      // User-rejected or unsupported; nothing actionable.
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        void toggleFullscreen();
      }
    },
    [toggleFullscreen],
  );

  const displayName = participant.name ?? participant.identity;
  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={`${displayName} is sharing their screen`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative h-full w-full overflow-hidden rounded-md border border-subtle bg-canvas focus:outline-none focus:ring-2 focus:ring-ember"
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={participant.isLocal}
        // `object-contain` matters for screen shares — `cover` would crop text.
        className="h-full w-full object-contain"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-overlay/80 px-3 py-2 text-xs"
      >
        <span className="truncate">{displayName} · sharing their screen</span>
      </div>
      <div className="absolute right-2 top-2 flex gap-1">
        <button
          type="button"
          onClick={onTogglePin}
          className="rounded-md bg-overlay/80 p-1.5 text-fg hover:bg-overlay focus:outline-none focus:ring-2 focus:ring-ember"
          aria-pressed={isPinned}
          title={isPinned ? 'Unpin this share' : 'Pin this share'}
        >
          {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          className="rounded-md bg-overlay/80 p-1.5 text-fg hover:bg-overlay focus:outline-none focus:ring-2 focus:ring-ember"
          aria-pressed={fullscreen}
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'}
        >
          {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
    </div>
  );
}
