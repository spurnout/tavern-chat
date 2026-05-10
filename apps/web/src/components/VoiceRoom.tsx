import { useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { Mic, MicOff, Monitor, MonitorOff, Video, VideoOff, PhoneOff } from 'lucide-react';
import { api } from '../lib/api-client.js';

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

interface Props {
  channelId: string;
  channelName: string;
  onLeave: () => void;
}

export function VoiceRoom({ channelId, channelName, onLeave }: Props): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'idle'>('idle');
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Array<LocalParticipant | RemoteParticipant>>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [allowed, setAllowed] = useState<JoinResponse['allowedFeatures'] | null>(null);

  useEffect(() => {
    let mounted = true;
    let connectedRoom: Room | null = null;
    async function join() {
      setStatus('connecting');
      setError(null);
      try {
        const join = await api<JoinResponse>('/voice/join', {
          method: 'POST',
          body: { channelId },
        });
        if (!mounted) return;
        setAllowed(join.allowedFeatures);

        const r = new Room({
          adaptiveStream: true,
          dynacast: true,
        });

        r.on(RoomEvent.ParticipantConnected, () => syncParticipants(r));
        r.on(RoomEvent.ParticipantDisconnected, () => syncParticipants(r));
        r.on(RoomEvent.TrackSubscribed, () => syncParticipants(r));
        r.on(RoomEvent.TrackUnsubscribed, () => syncParticipants(r));
        r.on(RoomEvent.ActiveSpeakersChanged, () => syncParticipants(r));
        r.on(RoomEvent.Disconnected, () => {
          setStatus('idle');
          setRoom(null);
        });

        await r.connect(join.liveKitUrl, join.token);
        if (join.allowedFeatures.canPublishAudio) {
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

        function syncParticipants(rm: Room): void {
          const all: Array<LocalParticipant | RemoteParticipant> = [
            rm.localParticipant,
            ...Array.from(rm.remoteParticipants.values()),
          ];
          setParticipants(all);
        }
      } catch (e) {
        if (!mounted) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Failed to enter voice room');
      }
    }
    void join();
    return () => {
      mounted = false;
      if (connectedRoom) {
        void connectedRoom.disconnect();
      }
    };
  }, [channelId]);

  async function toggleMic(): Promise<void> {
    if (!room) return;
    const next = !muted;
    setMuted(next);
    await room.localParticipant.setMicrophoneEnabled(!next);
  }

  async function toggleCamera(): Promise<void> {
    if (!room || !allowed?.canPublishVideo) return;
    const next = !cameraOn;
    setCameraOn(next);
    await room.localParticipant.setCameraEnabled(next);
  }

  async function toggleScreenShare(): Promise<void> {
    if (!room || !allowed?.canPublishScreenShare) return;
    const next = !screenOn;
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenOn(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not toggle screen share');
    }
  }

  async function leave(): Promise<void> {
    if (room) {
      await room.disconnect();
    }
    await api('/voice/leave', { method: 'POST' }).catch(() => undefined);
    onLeave();
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between border-b border-subtle px-4 py-3">
        <div>
          <div className="font-serif font-medium">🔊 {channelName}</div>
          <div className="text-xs text-fg-muted">
            {status === 'connecting' && 'Connecting…'}
            {status === 'connected' && `${participants.length} in room`}
            {status === 'error' && (error ?? 'Could not enter voice room')}
          </div>
        </div>
        <div className="flex gap-2">
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
          <button
            type="button"
            className={screenOn ? 'btn-primary' : 'btn-ghost'}
            onClick={() => void toggleScreenShare()}
            disabled={status !== 'connected' || !allowed?.canPublishScreenShare}
            aria-pressed={screenOn}
            title={screenOn ? 'Stop screen share' : 'Share screen'}
          >
            {screenOn ? <Monitor size={16} /> : <MonitorOff size={16} />}
          </button>
          <button
            type="button"
            className="btn bg-danger text-fg-on-accent hover:bg-danger-hi"
            onClick={() => void leave()}
            title="Leave voice"
          >
            <PhoneOff size={16} />
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3">
        {participants.map((p) => (
          <ParticipantTile key={p.identity} participant={p} />
        ))}
        {participants.length === 0 && status === 'connected' ? (
          <div className="col-span-full grid place-items-center text-fg-muted">
            Just you for now.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ParticipantTile({
  participant,
}: {
  participant: LocalParticipant | RemoteParticipant;
}): JSX.Element {
  const speaking = participant.isSpeaking;
  const screenTrack = participant.getTrackPublication(Track.Source.ScreenShare);
  const cameraTrack = participant.getTrackPublication(Track.Source.Camera);
  const activeTrack =
    screenTrack && !screenTrack.isMuted && screenTrack.track ? screenTrack : cameraTrack;
  const hasVideo = !!activeTrack && !activeTrack.isMuted && !!activeTrack.track;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const track = activeTrack?.track;
    const el = videoRef.current;
    if (!track || !el || !hasVideo) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [activeTrack, hasVideo]);

  const displayName = participant.name ?? participant.identity;
  return (
    <div
      // role="status" makes mic / speaking / sharing state changes announce
      // politely to assistive tech. The speaking border is decorative.
      role="status"
      aria-label={`${displayName}${participant.isMicrophoneEnabled ? ', mic on' : ', mic off'}${
        screenTrack && !screenTrack.isMuted ? ', sharing screen' : ''
      }`}
      className={`relative aspect-video overflow-hidden rounded-md border bg-surface ${
        speaking ? 'border-ember' : 'border-subtle'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="grid h-full place-items-center font-serif text-2xl font-semibold">
          {displayName.slice(0, 2).toUpperCase()}
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/40 px-2 py-1 text-xs"
      >
        <span className="truncate">
          {displayName}
          {screenTrack && !screenTrack.isMuted ? ' · sharing screen' : ''}
        </span>
        <span className={speaking ? 'text-ember' : 'text-fg-muted'}>
          {participant.isMicrophoneEnabled ? '🎙' : '🔇'}
        </span>
      </div>
    </div>
  );
}
