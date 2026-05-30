import { useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import type { LocalParticipant, RemoteParticipant } from 'livekit-client';
import { Circle, Mic, MicOff, Volume2 } from 'lucide-react';
import { MemberProfileTrigger } from '../MemberProfileTrigger.js';
import { SpeakingIndicator } from '../SpeakingIndicator.js';
import { useVoiceParticipantVolume } from './useVoiceParticipantVolume.js';

type ParticipantAny = LocalParticipant | RemoteParticipant;

export interface ParticipantCameraTileProps {
  participant: ParticipantAny;
  serverId: string;
  compact?: boolean;
  /** Wave 3 #25 — present on stage channels only. */
  stageBadge?: 'speaker' | 'audience' | null;
  handRaised?: boolean;
  hostActions?: { onPromote: () => void; onDemote: () => void } | null;
  /** Wave 3 #32 — show a red dot in the corner while recording is active. */
  recordingActive?: boolean;
}

export function ParticipantCameraTile({
  participant,
  serverId,
  compact = false,
  stageBadge = null,
  handRaised = false,
  hostActions = null,
  recordingActive = false,
}: ParticipantCameraTileProps): JSX.Element {
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

  // Wave 3 #31 — per-user audio mixer. Sliders on remote participants only;
  // your own outgoing level is set by the OS mic. Persisted by identity so
  // a reconnect (or a re-join after navigating away) restores the chosen
  // mix. Local-only — never sent to the server.
  const [volume, setVolume] = useVoiceParticipantVolume(participant);

  const displayName = participant.name ?? participant.identity;
  return (
    <div
      role="status"
      aria-label={`${displayName}${participant.isMicrophoneEnabled ? ', mic on' : ', mic off'}`}
      className={`group relative aspect-video overflow-hidden rounded-md border bg-surface transition-base ${
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
        <div
          className={`grid h-full place-items-center font-serif font-semibold ${compact ? 'text-base' : 'text-2xl'}`}
        >
          {displayName.slice(0, 2).toUpperCase()}
        </div>
      )}
      {handRaised ? (
        <span className="absolute left-1 top-1 rounded bg-tint-ember px-1.5 py-0.5 text-[10px] font-medium text-fg">
          Hand raised
        </span>
      ) : null}
      {recordingActive ? (
        <span
          className="absolute right-1 top-1 inline-flex items-center gap-1 rounded bg-overlay/80 px-1.5 py-0.5 text-[10px] text-fg"
          title="This session is being recorded"
        >
          <Circle size={8} className="fill-rust text-rust" />
          REC
        </span>
      ) : null}
      {stageBadge === 'audience' ? (
        <span className="absolute left-1 bottom-7 rounded bg-sunken/80 px-1.5 py-0.5 text-[10px] text-fg-muted">
          Audience
        </span>
      ) : null}
      {hostActions ? (
        <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {stageBadge === 'audience' ? (
            <button
              type="button"
              onClick={hostActions.onPromote}
              className="rounded bg-surface/90 px-2 py-0.5 text-[10px] hover:bg-raised"
              title="Promote to speaker"
            >
              Promote
            </button>
          ) : null}
          {stageBadge === 'speaker' ? (
            <button
              type="button"
              onClick={hostActions.onDemote}
              className="rounded bg-surface/90 px-2 py-0.5 text-[10px] hover:bg-raised"
              title="Demote to audience"
            >
              Demote
            </button>
          ) : null}
        </div>
      ) : null}
      <MemberProfileTrigger
        userId={participant.identity}
        serverId={serverId}
        side="top"
        align="start"
      >
        <button
          type="button"
          aria-label={`View profile of ${displayName}`}
          className="absolute inset-x-0 bottom-0 flex w-full items-center justify-between bg-overlay/80 px-2 py-1 text-xs hover:bg-overlay/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
        >
          <span className="truncate">{displayName}</span>
          <span
            aria-hidden
            className={speaking ? 'text-ember' : 'text-fg-muted'}
          >
            {participant.isMicrophoneEnabled ? (
              speaking ? <SpeakingIndicator /> : <Mic size={12} />
            ) : (
              <MicOff size={12} />
            )}
          </span>
        </button>
      </MemberProfileTrigger>
      {!participant.isLocal && volume !== null ? (
        <div className="group/vol pointer-events-none absolute right-1 top-1">
          <button
            type="button"
            className="pointer-events-auto rounded bg-overlay/80 p-1 text-fg-muted hover:bg-overlay focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
            aria-label={`Audio volume for ${displayName}`}
            title={`Volume: ${Math.round(volume * 100)}%`}
            onClick={(e) => e.stopPropagation()}
          >
            <Volume2 size={12} />
          </button>
          <div className="pointer-events-auto absolute right-0 top-full mt-1 hidden rounded border border-subtle bg-surface p-2 shadow-lg group-hover/vol:block">
            <label className="block text-[10px] uppercase tracking-wider text-fg-muted">
              Volume
            </label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              onChange={(e) => setVolume(Number(e.target.value) / 100)}
              className="mt-1 h-1 w-28 cursor-pointer accent-ember"
              aria-label={`Volume for ${displayName}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
