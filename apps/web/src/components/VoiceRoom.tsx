import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Pin,
  PinOff,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { api } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover.js';

interface JoinResponse {
  liveKitUrl: string;
  token: string;
  roomName: string;
  identity: string;
  allowedFeatures: {
    canPublishAudio: boolean;
    canPublishVideo: boolean;
    canPublishScreenShare: boolean;
    canSubscribe: boolean;
  };
  expiresAt: string;
}

export interface ScreenShareOptions {
  /** Capture system / tab audio along with the picture. */
  audio: boolean;
  /** `'text'` biases the encoder toward sharp glyphs; `'motion'` is the default. */
  contentHint: 'motion' | 'text';
}

// `null` = treat as a deliberate user cancellation; don't show any error UI.
const SCREEN_ERROR_MAP: Record<string, string | null> = {
  NotAllowedError: "You'll need to allow screen sharing in your browser.",
  NotFoundError: 'No screen, window, or tab was selected.',
  NotReadableError: "Your browser couldn't read that screen.",
  AbortError: null,
  InvalidStateError: null,
};

type ParticipantAny = LocalParticipant | RemoteParticipant;

interface Props {
  channelId: string;
  channelName: string;
  onLeave: () => void;
}

export function VoiceRoom({ channelId, channelName, onLeave }: Props): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'error' | 'idle'>('idle');
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<ParticipantAny[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  const [shareDropped, setShareDropped] = useState(false);
  const [allowed, setAllowed] = useState<JoinResponse['allowedFeatures'] | null>(null);
  const [shareOptions, setShareOptions] = useState<ScreenShareOptions>({
    audio: true,
    contentHint: 'motion',
  });

  // Coalesces voice-state POSTs so a rapid toggle doesn't fire three requests.
  const stateBuffer = useRef<Partial<Record<'screenSharing' | 'cameraOn' | 'selfMute' | 'selfDeaf', boolean>>>({});
  const stateTimer = useRef<number | null>(null);
  // FE-04: hold reportVoiceState in a ref so the join effect (which captures
  // it at mount) and per-event RoomEvent listeners (registered inside that
  // effect) all see the latest channelId-bound implementation. Previously the
  // useCallback identity was rebuilt on channelId change but the join-effect
  // closure already had the prior reference baked in.
  const reportVoiceStateRef = useRef<
    (partial: Partial<Record<'screenSharing' | 'cameraOn' | 'selfMute' | 'selfDeaf', boolean>>) => void
  >(() => {});
  reportVoiceStateRef.current = useCallback(
    (
      partial: Partial<Record<'screenSharing' | 'cameraOn' | 'selfMute' | 'selfDeaf', boolean>>,
    ) => {
      stateBuffer.current = { ...stateBuffer.current, ...partial };
      if (stateTimer.current !== null) window.clearTimeout(stateTimer.current);
      stateTimer.current = window.setTimeout(() => {
        const body = { channelId, ...stateBuffer.current };
        stateBuffer.current = {};
        stateTimer.current = null;
        api('/voice/state', { method: 'POST', body }).catch(() => undefined);
      }, 200);
    },
    [channelId],
  );
  const reportVoiceState = useCallback(
    (partial: Partial<Record<'screenSharing' | 'cameraOn' | 'selfMute' | 'selfDeaf', boolean>>) => {
      reportVoiceStateRef.current(partial);
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    let connectedRoom: Room | null = null;
    async function join(): Promise<void> {
      setStatus('connecting');
      setError(null);
      try {
        const joinRes = await api<JoinResponse>('/voice/join', {
          method: 'POST',
          body: { channelId },
        });
        if (!mounted) return;
        setAllowed(joinRes.allowedFeatures);

        const r = new Room({ adaptiveStream: true, dynacast: true });

        const syncParticipants = (rm: Room): void => {
          setParticipants([rm.localParticipant, ...Array.from(rm.remoteParticipants.values())]);
        };

        r.on(RoomEvent.ParticipantConnected, () => syncParticipants(r));
        r.on(RoomEvent.ParticipantDisconnected, () => syncParticipants(r));
        r.on(RoomEvent.TrackSubscribed, () => syncParticipants(r));
        r.on(RoomEvent.TrackUnsubscribed, () => syncParticipants(r));
        r.on(RoomEvent.TrackMuted, () => syncParticipants(r));
        r.on(RoomEvent.TrackUnmuted, () => syncParticipants(r));
        r.on(RoomEvent.ActiveSpeakersChanged, () => syncParticipants(r));
        r.on(RoomEvent.LocalTrackPublished, (pub) => {
          // `room.disconnect()` during cleanup fires these handlers after the
          // component has unmounted; skip state writes and POSTs in that case.
          if (!mounted) return;
          if (pub.source === Track.Source.ScreenShare) {
            setScreenOn(true);
            setShareDropped(false);
            reportVoiceState({ screenSharing: true });
          }
          if (pub.source === Track.Source.Camera) {
            setCameraOn(true);
            reportVoiceState({ cameraOn: true });
          }
          syncParticipants(r);
        });
        r.on(RoomEvent.LocalTrackUnpublished, (pub) => {
          if (!mounted) return;
          if (pub.source === Track.Source.ScreenShare) {
            setScreenOn(false);
            reportVoiceState({ screenSharing: false });
          }
          if (pub.source === Track.Source.Camera) {
            setCameraOn(false);
            reportVoiceState({ cameraOn: false });
          }
          syncParticipants(r);
        });
        r.on(RoomEvent.Reconnecting, () => setStatus('reconnecting'));
        r.on(RoomEvent.Reconnected, () => {
          setStatus('connected');
          // If we were sharing before the reconnect and the underlying media
          // track is now dead, surface a manual re-share affordance instead
          // of silently popping the browser's screen-pick dialog again.
          // We read LiveKit's view of the track here (not React state) because
          // this effect's closure was captured at mount and never refreshes.
          const pub = r.localParticipant.getTrackPublication(Track.Source.ScreenShare);
          const wasSharing = !!pub;
          const track = pub?.track?.mediaStreamTrack;
          if (wasSharing && (track === undefined || track.readyState === 'ended')) {
            setScreenOn(false);
            setShareDropped(true);
          }
        });
        r.on(RoomEvent.Disconnected, () => {
          setStatus('idle');
          setRoom(null);
        });

        await r.connect(joinRes.liveKitUrl, joinRes.token);
        if (joinRes.allowedFeatures.canPublishAudio) {
          await r.localParticipant.setMicrophoneEnabled(true);
        }
        if (!mounted) {
          await r.disconnect();
          return;
        }
        connectedRoom = r;
        setRoom(r);
        setStatus('connected');
        syncParticipants(r);
      } catch (e) {
        if (!mounted) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Could not pull up a chair to this room.');
      }
    }
    void join();
    return () => {
      mounted = false;
      if (stateTimer.current !== null) window.clearTimeout(stateTimer.current);
      if (connectedRoom) void connectedRoom.disconnect();
    };
    // `reportVoiceState` is stable for the lifetime of `channelId` so omitting
    // it from deps doesn't cause stale closures; the join effect should only
    // re-run when the user moves to a different room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function toggleMic(): Promise<void> {
    if (!room) return;
    const next = !muted;
    // FE-25: don't flip the optimistic state until LiveKit has actually
    // acknowledged the change. Otherwise a hardware failure (no mic, OS
    // permission revoke) leaves the UI showing "muted" / "unmuted" out of
    // sync with reality, and the stale state propagates via reportVoiceState.
    try {
      await room.localParticipant.setMicrophoneEnabled(!next);
      setMuted(next);
      reportVoiceState({ selfMute: next });
    } catch (err) {
      // FE-05: previously toggleMic swallowed any throw and left the UI in
      // a confusing in-between state. Now we surface a toast and leave the
      // toggle visually unchanged so the user knows the request didn't take.
      toast.error(
        err instanceof Error
          ? `Couldn't toggle the microphone: ${err.message}`
          : "Couldn't toggle the microphone.",
      );
    }
  }

  async function toggleCamera(): Promise<void> {
    if (!room || !allowed?.canPublishVideo) return;
    try {
      await room.localParticipant.setCameraEnabled(!cameraOn);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't toggle the camera.");
    }
  }

  const startScreenShare = useCallback(
    async (opts: ScreenShareOptions): Promise<void> => {
      if (!room || !allowed?.canPublishScreenShare) return;
      setError(null);
      try {
        await room.localParticipant.setScreenShareEnabled(true, {
          audio: opts.audio,
          contentHint: opts.contentHint,
        });
        setShareOptions(opts);
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        // The `null` entries mean "user cancelled" — surface nothing.
        if (name in SCREEN_ERROR_MAP) {
          const msg = SCREEN_ERROR_MAP[name];
          if (msg) setError(msg);
        } else {
          setError("Your browser wouldn't let us share that.");
        }
      }
    },
    [room, allowed],
  );

  async function stopScreenShare(): Promise<void> {
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch {
      // Track may already be ending; LocalTrackUnpublished will clean state.
    }
  }

  async function toggleScreenShare(): Promise<void> {
    if (screenOn) {
      await stopScreenShare();
    } else {
      await startScreenShare(shareOptions);
    }
  }

  async function leave(): Promise<void> {
    if (room) await room.disconnect();
    await api('/voice/leave', { method: 'POST' }).catch(() => undefined);
    onLeave();
  }

  const screenSharePublications = useMemo(() => {
    const out: Array<{ participant: ParticipantAny; pub: TrackPublication }> = [];
    for (const p of participants) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub && !pub.isMuted && pub.track) out.push({ participant: p, pub });
    }
    return out;
  }, [participants]);

  const presenterMode = screenSharePublications.length > 0;
  const activeShare = useMemo(() => {
    if (screenSharePublications.length === 0) return null;
    if (pinnedIdentity) {
      const pinned = screenSharePublications.find(
        (s) => s.participant.identity === pinnedIdentity,
      );
      if (pinned) return pinned;
    }
    // Default to most-recently-started; LiveKit appends new tracks at the end.
    return screenSharePublications[screenSharePublications.length - 1] ?? null;
  }, [screenSharePublications, pinnedIdentity]);

  // Clear stale pin when the pinned share ends.
  useEffect(() => {
    if (pinnedIdentity && !screenSharePublications.find((s) => s.participant.identity === pinnedIdentity)) {
      setPinnedIdentity(null);
    }
  }, [pinnedIdentity, screenSharePublications]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-subtle px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Volume2 size={16} className="text-fg-muted shrink-0" />
          <div className="min-w-0">
            <div className="truncate font-serif font-medium">{channelName}</div>
            <div className="text-xs text-fg-muted">
              {status === 'connecting' && 'Pulling up a chair…'}
              {status === 'reconnecting' && 'Reconnecting…'}
              {status === 'connected' && `${participants.length} around the table`}
              {status === 'error' && (error ?? 'Could not enter the room.')}
              {status === 'idle' && 'Left the room.'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={muted ? 'btn-ghost' : 'btn-primary'}
            onClick={() => void toggleMic()}
            disabled={status !== 'connected'}
            aria-pressed={!muted}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            type="button"
            className={cameraOn ? 'btn-primary' : 'btn-ghost'}
            onClick={() => void toggleCamera()}
            disabled={status !== 'connected' || !allowed?.canPublishVideo}
            aria-pressed={cameraOn}
            title={cameraOn ? 'Stop camera' : 'Start camera'}
          >
            {cameraOn ? <Video size={16} /> : <VideoOff size={16} />}
          </button>
          <div className="flex items-center">
            <button
              type="button"
              className={screenOn ? 'btn-primary' : 'btn-ghost'}
              onClick={() => void toggleScreenShare()}
              disabled={status !== 'connected' || !allowed?.canPublishScreenShare}
              aria-pressed={screenOn}
              title={
                !allowed?.canPublishScreenShare
                  ? "Screen sharing isn't allowed in this room."
                  : screenOn
                    ? 'Stop sharing'
                    : 'Share your screen'
              }
            >
              {screenOn ? <Monitor size={16} /> : <MonitorOff size={16} />}
            </button>
            <ScreenShareSettingsPopover
              disabled={status !== 'connected' || !allowed?.canPublishScreenShare || screenOn}
              value={shareOptions}
              onChange={setShareOptions}
            />
          </div>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void leave()}
            title="Leave the room"
          >
            <PhoneOff size={16} />
          </button>
        </div>
      </header>

      {shareDropped ? (
        <div className="flex items-center justify-between gap-3 border-b border-subtle bg-tint-ember px-4 py-2 text-sm">
          <span>Your screen share dropped during the reconnect.</span>
          <button
            type="button"
            className="btn-ghost text-fg"
            onClick={() => {
              setShareDropped(false);
              void startScreenShare(shareOptions);
            }}
          >
            Share again
          </button>
        </div>
      ) : null}

      {presenterMode && activeShare ? (
        <PresenterLayout
          active={activeShare}
          participants={participants}
          pinnedIdentity={pinnedIdentity}
          onTogglePin={(identity) =>
            setPinnedIdentity((current) => (current === identity ? null : identity))
          }
        />
      ) : (
        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3">
          {participants.map((p) => (
            <ParticipantCameraTile key={p.identity} participant={p} />
          ))}
          {participants.length === 0 && status === 'connected' ? (
            <div className="col-span-full grid place-items-center text-fg-muted">
              Just you for now.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface PresenterLayoutProps {
  active: { participant: ParticipantAny; pub: TrackPublication };
  participants: ParticipantAny[];
  pinnedIdentity: string | null;
  onTogglePin: (identity: string) => void;
}

function PresenterLayout({
  active,
  participants,
  pinnedIdentity,
  onTogglePin,
}: PresenterLayoutProps): JSX.Element {
  const isPinned = pinnedIdentity === active.participant.identity;
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex-1 min-h-0 px-4 pt-4">
        <ScreenShareTile
          participant={active.participant}
          publication={active.pub}
          isPinned={isPinned}
          onTogglePin={() => onTogglePin(active.participant.identity)}
        />
      </div>
      <div className="flex shrink-0 gap-2 overflow-x-auto px-4 py-3">
        {participants.map((p) => (
          <div key={p.identity} className="w-32 shrink-0">
            <ParticipantCameraTile participant={p} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function ParticipantCameraTile({
  participant,
  compact = false,
}: {
  participant: ParticipantAny;
  compact?: boolean;
}): JSX.Element {
  const speaking = participant.isSpeaking;
  const cameraTrack = participant.getTrackPublication(Track.Source.Camera);
  const hasVideo = !!cameraTrack && !cameraTrack.isMuted && !!cameraTrack.track;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Watching `cameraTrack?.track` (not just the publication object) matters:
  // LiveKit can swap the underlying MediaStreamTrack on the same publication
  // after a reconnect/codec switch, and we'd otherwise hold a dead reference.
  const track = cameraTrack?.track;
  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el || !hasVideo) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, hasVideo]);

  const displayName = participant.name ?? participant.identity;
  return (
    <div
      role="status"
      aria-label={`${displayName}${participant.isMicrophoneEnabled ? ', mic on' : ', mic off'}`}
      className={`relative aspect-video overflow-hidden rounded-md border bg-surface transition-base ${
        speaking ? 'border-ember' : 'border-subtle'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className={`grid h-full place-items-center font-serif font-semibold ${compact ? 'text-base' : 'text-2xl'}`}>
          {displayName.slice(0, 2).toUpperCase()}
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-overlay/80 px-2 py-1 text-xs"
      >
        <span className="truncate">{displayName}</span>
        <span className={speaking ? 'text-ember' : 'text-fg-muted'}>
          {participant.isMicrophoneEnabled ? <Mic size={12} /> : <MicOff size={12} />}
        </span>
      </div>
    </div>
  );
}

function ScreenShareTile({
  participant,
  publication,
  isPinned,
  onTogglePin,
}: {
  participant: ParticipantAny;
  publication: TrackPublication;
  isPinned: boolean;
  onTogglePin: () => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // Depend on `publication.track` rather than the publication object so a
  // post-reconnect track replacement still re-attaches the live stream.
  const track = publication.track;
  useEffect(() => {
    const el = videoRef.current;
    if (!track || !el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

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
