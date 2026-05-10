import { useEffect, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteParticipant,
} from 'livekit-client';
import { Mic, MicOff, Video, VideoOff, PhoneOff } from 'lucide-react';
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
  const [allowed, setAllowed] = useState<JoinResponse['allowedFeatures'] | null>(null);

  useEffect(() => {
    let mounted = true;
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
        setError(e instanceof Error ? e.message : 'Failed to join voice');
      }
    }
    void join();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function leave(): Promise<void> {
    if (room) {
      await room.disconnect();
    }
    await api('/voice/leave', { method: 'POST' }).catch(() => undefined);
    onLeave();
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between border-b border-tavern-oak px-4 py-3">
        <div>
          <div className="font-semibold">🔊 {channelName}</div>
          <div className="text-xs text-tavern-mist">
            {status === 'connecting' && 'Connecting…'}
            {status === 'connected' && `${participants.length} in room`}
            {status === 'error' && (error ?? 'Could not join voice')}
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
            className="btn bg-red-700 text-white hover:bg-red-600"
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
          <div className="col-span-full grid place-items-center text-tavern-mist">
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
  const cameraTrack = participant.getTrackPublication(Track.Source.Camera);
  const hasVideo = !!cameraTrack && !cameraTrack.isMuted && !!cameraTrack.track;

  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-md border bg-tavern-stone ${
        speaking ? 'border-tavern-ember' : 'border-tavern-oak'
      }`}
    >
      {hasVideo ? (
        <video
          ref={(el) => {
            if (el && cameraTrack?.track) {
              cameraTrack.track.attach(el);
            }
          }}
          autoPlay
          playsInline
          muted={participant.isLocal}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full place-items-center text-2xl font-semibold">
          {(participant.name ?? participant.identity).slice(0, 2).toUpperCase()}
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/40 px-2 py-1 text-xs">
        <span className="truncate">{participant.name ?? participant.identity}</span>
        <span className={speaking ? 'text-tavern-ember' : 'text-tavern-mist'}>
          {participant.isMicrophoneEnabled ? '🎙' : '🔇'}
        </span>
      </div>
    </div>
  );
}
