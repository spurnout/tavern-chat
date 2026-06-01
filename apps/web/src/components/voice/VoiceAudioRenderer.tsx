import { useEffect, useRef, useState } from 'react';
import {
  RoomEvent,
  Track,
  type RemoteTrack,
  type Room,
} from 'livekit-client';
import { Volume2 } from 'lucide-react';
import { usePreferences } from '../../lib/preferences-store.js';

/**
 * Plays remote participants' audio.
 *
 * This component is the thing that was missing: the room is hand-managed (no
 * `@livekit/components-react` `<RoomAudioRenderer>`), and the participant
 * tiles only ever attach *video* tracks. With nothing attaching remote
 * microphone tracks to an audio element, everyone could connect to a voice
 * room and hear silence. Here we attach every subscribed remote audio track
 * (microphone + screen-share audio) to a hidden `<audio>` element.
 *
 * Two browser realities are handled:
 *  - Autoplay policy: if the browser blocks playback (no qualifying user
 *    gesture yet) we surface a "click to enable sound" button that calls
 *    `room.startAudio()` from within the click handler.
 *  - Output routing: newly attached elements honour the user's selected
 *    speaker via setSinkId (Chromium; Firefox falls back to the default).
 */
export function VoiceAudioRenderer({ room }: { room: Room }): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elementsRef = useRef<Map<string, { track: RemoteTrack; el: HTMLMediaElement }>>(new Map());
  const [blocked, setBlocked] = useState(!room.canPlaybackAudio);
  const outputDeviceId = usePreferences((s) => s.audioOutputDeviceId);

  // Attach / detach lifecycle. Keyed on `room` only — output-device changes
  // are handled by the separate effect below so we don't tear every element
  // down (and drop audio for a beat) when the user picks a new speaker.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const elements = elementsRef.current;

    // `track.sid` can be undefined before the server assigns one; fall back to
    // the MediaStreamTrack id, which is always present, so the dedupe key is
    // stable either way.
    const keyOf = (track: RemoteTrack): string => track.sid ?? track.mediaStreamTrack.id;

    const applySink = (el: HTMLMediaElement): void => {
      if (outputDeviceId === 'default') return;
      const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      withSink.setSinkId?.(outputDeviceId).catch(() => undefined);
    };

    const attach = (track: RemoteTrack): void => {
      if (track.kind !== Track.Kind.Audio) return;
      const key = keyOf(track);
      if (elements.has(key)) return;
      const el = track.attach();
      el.autoplay = true;
      applySink(el);
      host.appendChild(el);
      elements.set(key, { track, el });
    };

    const detach = (track: RemoteTrack): void => {
      const key = keyOf(track);
      const entry = elements.get(key);
      if (!entry) return;
      track.detach(entry.el);
      entry.el.remove();
      elements.delete(key);
    };

    // Catch up on tracks subscribed before this effect ran.
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (pub.isSubscribed && pub.track && pub.kind === Track.Kind.Audio) {
          attach(pub.track as RemoteTrack);
        }
      });
    });

    const onSubscribed = (track: RemoteTrack): void => attach(track);
    const onUnsubscribed = (track: RemoteTrack): void => detach(track);
    const onPlaybackChanged = (): void => setBlocked(!room.canPlaybackAudio);

    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    room.on(RoomEvent.AudioPlaybackStatusChanged, onPlaybackChanged);

    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
      room.off(RoomEvent.AudioPlaybackStatusChanged, onPlaybackChanged);
      elements.forEach(({ track, el }) => {
        track.detach(el);
        el.remove();
      });
      elements.clear();
    };
    // outputDeviceId intentionally omitted — see the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  // Re-route already-playing audio when the user picks a different speaker.
  useEffect(() => {
    if (outputDeviceId === 'default') return;
    elementsRef.current.forEach(({ el }) => {
      const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
      withSink.setSinkId?.(outputDeviceId).catch(() => undefined);
    });
  }, [outputDeviceId]);

  return (
    <>
      <div ref={hostRef} className="hidden" aria-hidden />
      {blocked && (
        <button
          type="button"
          onClick={() => void room.startAudio()}
          className="btn-primary fixed bottom-4 left-1/2 z-50 -translate-x-1/2 shadow-lg"
        >
          <Volume2 size={15} className="mr-1.5 inline-block" />
          Click to enable sound
        </button>
      )}
    </>
  );
}
