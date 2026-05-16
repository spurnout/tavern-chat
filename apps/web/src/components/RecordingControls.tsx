import { useEffect, useRef, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import { Circle, Square } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { uploadFile } from '../lib/uploads.js';
import {
  onRecordingConsentUpdate,
  onRecordingStarted,
  onRecordingStopped,
} from '../lib/voice-events.js';

interface Props {
  channelId: string;
  room: Room | null;
  meId: string;
  /** LiveKit identities of everyone currently in the room. */
  participantIds: string[];
  isHost: boolean;
}

type Phase = 'idle' | 'proposing' | 'collecting' | 'ready' | 'recording' | 'uploading';

/**
 * Wave 3 #32 — host-facing recording controls + remote-watcher indicator.
 *
 * The host walks a small state machine:
 *   idle → proposing (clicked button, awaiting server-side fanout)
 *         → collecting (consent dialogs are out; track responses)
 *         → ready    (every non-self participant said yes)
 *         → recording (MediaRecorder running, /start fired)
 *         → uploading (stop pressed, .webm being uploaded)
 *         → idle      (completed)
 *
 * Non-hosts only render a red dot when phase is 'recording'. The dot
 * comes from the gateway `RECORDING_STARTED` / `RECORDING_STOPPED` events,
 * not from local-side bookkeeping — so it shows for every participant.
 */
export function RecordingControls({
  channelId,
  room,
  meId,
  participantIds,
  isHost,
}: Props): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [consents, setConsents] = useState<Record<string, boolean>>({});
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTsRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Reflect remote start / stop. Both host and non-host need to track the
  // 'recording' phase so the indicator stays in sync with the wire.
  useEffect(() => {
    const offStart = onRecordingStarted((p) => {
      if (p.channelId !== channelId) return;
      setPhase('recording');
    });
    const offStop = onRecordingStopped((p) => {
      if (p.channelId !== channelId) return;
      setPhase('idle');
      setConsents({});
    });
    return () => {
      offStart();
      offStop();
    };
  }, [channelId]);

  // Host tracks consent responses.
  useEffect(() => {
    if (!isHost) return;
    const off = onRecordingConsentUpdate((p) => {
      if (p.channelId !== channelId) return;
      setConsents((prev) => ({ ...prev, [p.userId]: p.consent }));
    });
    return off;
  }, [channelId, isHost]);

  // When every non-host participant has allowed, flip to 'ready'.
  useEffect(() => {
    if (phase !== 'collecting') return;
    const need = participantIds.filter((id) => id !== meId);
    if (need.length === 0) {
      // Solo room — allow self-record without further prompting.
      setPhase('ready');
      return;
    }
    const anyNo = need.some((id) => consents[id] === false);
    if (anyNo) {
      setPhase('idle');
      toast.error('Someone denied recording.');
      return;
    }
    const allYes = need.every((id) => consents[id] === true);
    if (allYes) setPhase('ready');
  }, [phase, consents, participantIds, meId]);

  async function propose(): Promise<void> {
    setPhase('proposing');
    setConsents({});
    try {
      await api(`/voice/${channelId}/recording/propose`, { method: 'POST' });
      setPhase('collecting');
    } catch (err) {
      setPhase('idle');
      toast.error(err instanceof ApiError ? err.message : 'Could not propose recording');
    }
  }

  async function start(): Promise<void> {
    if (!room) {
      toast.error('Voice room not connected.');
      return;
    }
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      audioCtxRef.current = ctx;

      // Mix host mic into the recording destination.
      const localPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      const localTrack = localPub?.audioTrack?.mediaStreamTrack;
      if (localTrack) {
        ctx.createMediaStreamSource(new MediaStream([localTrack])).connect(dest);
      }

      // Plus every remote participant's audio publications.
      for (const rp of room.remoteParticipants.values()) {
        for (const pub of rp.audioTrackPublications.values()) {
          const track = pub.audioTrack?.mediaStreamTrack;
          if (track) {
            ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
          }
        }
      }

      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mime
        ? new MediaRecorder(dest.stream, { mimeType: mime })
        : new MediaRecorder(dest.stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      startTsRef.current = Date.now();
      recorder.start(1000);
      await api(`/voice/${channelId}/recording/start`, { method: 'POST' });
      setPhase('recording');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start recording');
      setPhase('idle');
    }
  }

  async function stop(): Promise<void> {
    const recorder = recorderRef.current;
    if (!recorder) return;
    setPhase('uploading');
    const endedAt = new Date();
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const file = new File([blob], `recording-${endedAt.toISOString()}.webm`, {
      type: 'audio/webm',
    });
    try {
      const att = await uploadFile({ file, channelId, kind: 'audio' });
      await api(`/voice/${channelId}/recording/complete`, {
        method: 'POST',
        body: {
          attachmentId: att.id,
          startedAt: new Date(startTsRef.current).toISOString(),
          endedAt: endedAt.toISOString(),
        },
      });
      toast.success('Recording saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save recording');
    } finally {
      setPhase('idle');
      chunksRef.current = [];
      recorderRef.current = null;
    }
  }

  // Non-hosts: only the red dot when recording is active.
  if (!isHost) {
    return phase === 'recording' ? (
      <span className="inline-flex items-center gap-1 rounded bg-tint-rust px-2 py-1 text-xs text-fg">
        <Circle size={10} className="fill-rust text-rust" /> Recording
      </span>
    ) : null;
  }

  if (phase === 'idle' || phase === 'proposing') {
    return (
      <button
        type="button"
        className="btn-ghost"
        onClick={() => void propose()}
        disabled={phase === 'proposing'}
        title="Propose recording"
      >
        <Circle size={16} />
      </button>
    );
  }

  if (phase === 'collecting') {
    const need = participantIds.filter((id) => id !== meId);
    const yes = need.filter((id) => consents[id] === true).length;
    return (
      <span className="rounded bg-tint-mead px-2 py-1 text-xs">
        Waiting for consent ({yes}/{need.length})
      </span>
    );
  }

  if (phase === 'ready') {
    return (
      <button
        type="button"
        className="btn-primary"
        onClick={() => void start()}
        title="Start recording"
      >
        <Circle size={14} className="mr-1 fill-rust text-rust" /> Start
      </button>
    );
  }

  if (phase === 'recording') {
    return (
      <button
        type="button"
        className="btn-danger"
        onClick={() => void stop()}
        title="Stop recording"
      >
        <Square size={14} className="mr-1" /> Stop
      </button>
    );
  }

  if (phase === 'uploading') {
    return <span className="text-xs text-fg-muted">Saving…</span>;
  }

  return null;
}
