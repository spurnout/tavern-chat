import { useEffect, useState } from 'react';
import type { LocalParticipant, RemoteParticipant } from 'livekit-client';

type ParticipantAny = LocalParticipant | RemoteParticipant;

/**
 * Per-participant local audio volume, in [0, 1]. Persists to localStorage
 * keyed by participant identity so the mix survives reconnects. Returns
 * `null` for participants where setVolume isn't available (local participant
 * or older LiveKit clients) so the caller can hide the slider entirely.
 */
export function useVoiceParticipantVolume(
  participant: ParticipantAny,
): [number | null, (next: number) => void] {
  const storageKey = `tavern.voiceVolume.${participant.identity}`;
  const [volume, setLocalVolume] = useState<number | null>(() => {
    if (participant.isLocal) return null;
    if (typeof window === 'undefined') return 1;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1;
  });

  // Apply the (possibly persisted) volume on mount and whenever the
  // participant identity changes. `setVolume` is on RemoteParticipant in
  // LiveKit v2+; feature-detect so older clients silently no-op.
  useEffect(() => {
    if (participant.isLocal || volume === null) return;
    const p = participant as { setVolume?: (v: number) => void };
    if (typeof p.setVolume === 'function') {
      p.setVolume(volume);
    }
  }, [participant, volume]);

  function update(next: number): void {
    const clamped = Math.max(0, Math.min(1, next));
    setLocalVolume(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, String(clamped));
    }
  }

  return [volume, update];
}
