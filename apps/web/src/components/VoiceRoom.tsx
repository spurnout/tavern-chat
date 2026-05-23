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
  Circle,
  Hand,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  Music,
  Pen,
  PhoneOff,
  Pin,
  PinOff,
  Users,
  Video,
  VideoOff,
  Volume2,
} from 'lucide-react';
import { Permission, type VoiceStateGatewayPayload } from '@tavern/shared';
import { api } from '../lib/api-client.js';
import { playSound } from '../lib/sound.js';
import { toast } from '../lib/toast.js';
import { useAuth } from '../lib/auth.js';
import { usePreferences } from '../lib/preferences-store.js';
import { useCanIn, useRealtime } from '../lib/store.js';

// Stable fallback for the "no voice states for this channel yet" path.
// Returning a fresh `{}` from the zustand selector re-fires
// useSyncExternalStore every render — same trap as the channelsByServer fix
// in server-home.tsx.
const EMPTY_VOICE_STATES: Record<string, VoiceStateGatewayPayload> = Object.freeze(
  {},
) as Record<string, VoiceStateGatewayPayload>;
import {
  onBreakoutClose,
  onBreakoutOpen,
  onRecordingStarted,
  onRecordingStopped,
} from '../lib/voice-events.js';
import { MemberProfileTrigger } from './MemberProfileTrigger.js';
import { ScreenShareSettingsPopover } from './ScreenShareSettingsPopover.js';
import { SpeakingIndicator } from './SpeakingIndicator.js';
import { SoundboardPanel } from './SoundboardPanel.js';
import { BreakoutsPanel } from './BreakoutsPanel.js';
import { RecordingConsentDialog } from './RecordingConsentDialog.js';
import { RecordingControls } from './RecordingControls.js';
import { WatchPartyPanel } from './WatchPartyPanel.js';
import { Whiteboard } from './Whiteboard.js';
import { LiveCaptions, CaptionsToggleButton } from './LiveCaptions.js';
import { useCaptions, type CaptionLine } from '../lib/captions-store.js';

// Stable module-scoped fallback for the "no captions for this channel
// yet" path. Same trap as the four selectors fixed in commit 7a9e99e:
// a fresh `[]` returned from a zustand selector re-fires
// useSyncExternalStore every render and trips React #185 ("Maximum
// update depth exceeded"). This fires on voice-join because the
// captions store is empty until somebody speaks with captions enabled.
const EMPTY_CAPTION_LINES: CaptionLine[] = [];

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
  /** Server this voice room belongs to — passed to the profile-card trigger. */
  serverId: string;
  onLeave: () => void;
  /**
   * Compact bar mode for when the user has navigated to a different channel
   * but is still in the voice call — shows channel name + controls only.
   * The LiveKit session lives in the same component instance, so flipping
   * this prop never tears down the connection.
   */
  minimized?: boolean;
  /** Click handler for the minimized bar's channel label — expand back to room view. */
  onExpand?: () => void;
}

export function VoiceRoom({
  channelId,
  channelName,
  serverId,
  onLeave,
  minimized = false,
  onExpand,
}: Props): JSX.Element {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting' | 'error' | 'idle'>('idle');
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<ParticipantAny[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  // Wave 3 #25 — stage rooms. We pull the channel object + voice-state slice
  // from the realtime store so the host affordances and the audience
  // raise-hand button can react to gateway-driven updates without VoiceRoom's
  // parent having to thread channel.type as a prop. Same lookup pattern as
  // ChannelPage / VoicePage.
  const me = useAuth((s) => s.me);
  const channel = useRealtime((s) => {
    for (const list of Object.values(s.channelsByServer)) {
      const c = list.find((c) => c.id === channelId);
      if (c) return c;
    }
    return null;
  });
  // Subscribe to the dict; derive via useMemo so the empty-case fallback
  // (no voice activity for this channel yet) stays a stable reference.
  const voiceStatesByChannel = useRealtime((s) => s.voiceStatesByChannel);
  const voiceStatesByUser = useMemo(
    () => voiceStatesByChannel[channelId] ?? EMPTY_VOICE_STATES,
    [voiceStatesByChannel, channelId],
  );
  const isStage = channel?.type === 'stage';
  const myVoiceState = me ? voiceStatesByUser[me.id] : undefined;
  const myStagePosition = myVoiceState?.stagePosition ?? null;
  const myHandRaisedAt = myVoiceState?.handRaisedAt ?? null;
  const isStageHost = useCanIn(serverId, Permission.MANAGE_CHANNELS);

  // Wave 3 #32 — track whether recording is active in this channel so each
  // participant tile can render a red dot. The state lives on the gateway
  // (start / stop events); we mirror it locally for the indicator.
  const [recordingActive, setRecordingActive] = useState(false);
  useEffect(() => {
    const offStart = onRecordingStarted((p) => {
      if (p.channelId === channelId) setRecordingActive(true);
    });
    const offStop = onRecordingStopped((p) => {
      if (p.channelId === channelId) setRecordingActive(false);
    });
    return () => {
      offStart();
      offStop();
    };
  }, [channelId]);
  const [screenOn, setScreenOn] = useState(false);
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  const [shareDropped, setShareDropped] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [breakoutsOpen, setBreakoutsOpen] = useState(false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(false);
  // Snapshot of the parent voice room's LiveKit URL captured at /voice/join.
  // Used to swap back when BREAKOUT_CLOSE fires after the user has been
  // moved into a child room.
  const parentJoinRef = useRef<{ liveKitUrl: string } | null>(null);
  // Subscribe to the dict; derive the per-channel slice via useMemo so the
  // empty-case fallback stays a stable reference across renders.
  const linesByChannel = useCaptions((s) => s.linesByChannel);
  const captionLines = useMemo<CaptionLine[]>(
    () => linesByChannel[channelId] ?? EMPTY_CAPTION_LINES,
    [linesByChannel, channelId],
  );
  const [allowed, setAllowed] = useState<JoinResponse['allowedFeatures'] | null>(null);
  const [shareOptions, setShareOptions] = useState<ScreenShareOptions>({
    audio: true,
    contentHint: 'motion',
  });
  // Visible state for the share button's disabled-while-publishing UI.
  // The actual race guard lives on `shareInflightRef` below — state alone
  // is not atomic enough, since two clicks within one render cycle both
  // see `shareInflight === false`.
  const [shareInflight, setShareInflight] = useState(false);
  // Controlled state for the share-options popover so we can force it
  // closed the moment sharing starts (the trigger goes disabled but a
  // popover already open at that moment would otherwise stay up).
  const [shareOptionsOpen, setShareOptionsOpen] = useState(false);
  // Mirror of `screenOn` for closures captured at mount. The Reconnected
  // handler reads this to distinguish "the share genuinely dropped" from
  // "the user pressed Chrome's Stop-sharing toolbar, and Unpublished is
  // about to fire any moment now."
  const screenOnRef = useRef(false);
  // Synchronous in-flight guard for toggleScreenShare. Set inside the
  // handler before any await so a double-click can't kick off two
  // getDisplayMedia calls in parallel.
  const shareInflightRef = useRef(false);

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
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * VC-001: refresh the LiveKit token before its 15-minute TTL expires.
     * Scheduled 5 minutes before the declared `expiresAt`, so a session
     * ends up rotating tokens every ~10 minutes. LiveKit tokens are used
     * at connect-time and on reconnect; we don't proactively reconnect
     * the live Room (too disruptive). The fresh token sits in our
     * reference so the next reconnect picks it up, and meanwhile the
     * server-side permission re-check on /voice/refresh-token narrows
     * `canPublishSources` if a role was demoted since /voice/join.
     */
    const scheduleRefresh = (expiresAtIso: string, room: Room): void => {
      const ms = new Date(expiresAtIso).getTime() - Date.now() - 5 * 60_000;
      if (ms <= 0) return;
      refreshTimer = setTimeout(() => {
        if (!mounted) return;
        void api<{ token: string; expiresAt: string }>(
          '/voice/refresh-token',
          { method: 'POST', body: { channelId } },
        )
          .then((refreshed) => {
            if (!mounted) return;
            // LiveKit Room exposes updateToken in @livekit/components-react
            // semantics; the runtime room ref may or may not have it depending
            // on SDK version. Best-effort: if the method exists, use it;
            // otherwise we've at least exercised the API path and the next
            // reconnect will pick up a fresh token on its own.
            const maybeUpdate = (
              room.localParticipant as unknown as {
                updateToken?: (token: string) => Promise<void>;
              }
            ).updateToken;
            if (typeof maybeUpdate === 'function') {
              void maybeUpdate.call(room.localParticipant, refreshed.token);
            }
            scheduleRefresh(refreshed.expiresAt, room);
          })
          .catch(() => {
            /* leave the existing token; reconnect will reissue */
          });
      }, ms);
    };

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

        // Wave 3 #30 — wire user prefs for browser-level noise suppression /
        // echo cancellation / auto-gain into the LiveKit Room's audio capture
        // defaults. Browsers apply these constraints on getUserMedia, so the
        // mic stream LiveKit publishes is already cleaned up. Defaults are
        // all-on, matching Discord / Teams / Meet behaviour.
        const prefs = usePreferences.getState();
        const r = new Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: {
            noiseSuppression: prefs.voiceNoiseSuppression,
            echoCancellation: prefs.voiceEchoCancellation,
            autoGainControl: prefs.voiceAutoGain,
          },
        });

        const syncParticipants = (rm: Room): void => {
          setParticipants([rm.localParticipant, ...Array.from(rm.remoteParticipants.values())]);
        };

        r.on(RoomEvent.ParticipantConnected, () => {
          syncParticipants(r);
          // Fires for remote participants only — LiveKit doesn't emit this
          // event for the local participant — so no self-guard needed.
          playSound('voice-join');
        });
        r.on(RoomEvent.ParticipantDisconnected, () => {
          syncParticipants(r);
          playSound('voice-leave');
        });
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
            screenOnRef.current = true;
            setScreenOn(true);
            setShareDropped(false);
            reportVoiceState({ screenSharing: true });
            playSound('screenshare-start');
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
            screenOnRef.current = false;
            setScreenOn(false);
            reportVoiceState({ screenSharing: false });
            playSound('screenshare-stop');
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
          // Only surface the "share dropped, click to re-share" banner if
          // (a) React still thinks the user is sharing and (b) the underlying
          // MediaStreamTrack actually ended. Without (a) we'd falsely show
          // the banner when the user pressed Chrome's Stop-sharing toolbar
          // during the reconnect — Unpublished is about to fire and clear
          // it anyway, but we'd flash the banner in the meantime.
          // We consult LiveKit + the ref (not React closure state) because
          // this listener was registered at mount and the closure is stale.
          const pub = r.localParticipant.getTrackPublication(Track.Source.ScreenShare);
          const wasSharing = !!pub && screenOnRef.current;
          const track = pub?.track?.mediaStreamTrack;
          if (wasSharing && (track === undefined || track.readyState === 'ended')) {
            screenOnRef.current = false;
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
        // Wave 3 #29 — stash the parent room's LiveKit URL so a breakout
        // close can reconnect us. The token alone is enough on its own,
        // but /voice/refresh-token doesn't return liveKitUrl so we have to
        // capture it here, at the original join, before we swap rooms.
        parentJoinRef.current = { liveKitUrl: joinRes.liveKitUrl };
        // VC-001: schedule the proactive token refresh once the room is up.
        scheduleRefresh(joinRes.expiresAt, r);
        setStatus('connected');
        syncParticipants(r);
        playSound('vc-self-join');
      } catch (e) {
        if (!mounted) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : 'Could not pull up a chair to this room.');
      }
    }
    // Defer the actual join by one tick so React StrictMode's first-mount
    // cleanup runs before any /voice/join hits the wire. Otherwise both
    // StrictMode mounts call /voice/join with the same LiveKit identity in
    // dev, LiveKit evicts the prior session, and the visible result is a
    // connect → "client leave request received" → reconnect loop.
    const joinScheduled = setTimeout(() => {
      if (!mounted) return;
      void join();
    }, 0);
    return () => {
      mounted = false;
      clearTimeout(joinScheduled);
      if (stateTimer.current !== null) window.clearTimeout(stateTimer.current);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (connectedRoom) void connectedRoom.disconnect();
    };
    // `reportVoiceState` is stable for the lifetime of `channelId` so omitting
    // it from deps doesn't cause stale closures; the join effect should only
    // re-run when the user moves to a different room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  // Wave 3 #29 — breakout room transitions. On BREAKOUT_OPEN, swap our
  // existing LiveKit connection to the assigned child room (if any). On
  // BREAKOUT_CLOSE, refresh the parent's token and reconnect.
  useEffect(() => {
    if (!room || !me) return;
    const offOpen = onBreakoutOpen((p) => {
      if (p.parentChannelId !== channelId) return;
      const myGroup = p.groups.find((g) => g.members.includes(me.id));
      if (!myGroup) return;
      if (!window.confirm(`You've been moved to ${myGroup.name}. Join now?`)) return;
      void (async () => {
        try {
          const joinRes = await api<{
            token: string;
            liveKitUrl: string;
            roomName: string;
            expiresAt: string;
          }>(`/breakouts/${myGroup.id}/join`, { method: 'POST' });
          await room.disconnect();
          await room.connect(joinRes.liveKitUrl, joinRes.token);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not switch to breakout');
        }
      })();
    });
    const offClose = onBreakoutClose((p) => {
      if (p.parentChannelId !== channelId) return;
      const parent = parentJoinRef.current;
      if (!parent) return;
      void (async () => {
        try {
          const fresh = await api<{ token: string; expiresAt: string }>(
            '/voice/refresh-token',
            { method: 'POST', body: { channelId } },
          );
          await room.disconnect();
          await room.connect(parent.liveKitUrl, fresh.token);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : 'Could not return to the parent room',
          );
        }
      })();
    });
    return () => {
      offOpen();
      offClose();
    };
  }, [room, me?.id, channelId, me]);

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
      playSound('mic-toggle');
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
    // Synchronous guard via ref: two clicks within the same render cycle
    // both observe `shareInflight === false` from React state, but only the
    // first one passes the ref check.
    if (shareInflightRef.current) return;
    shareInflightRef.current = true;
    setShareInflight(true);
    try {
      if (screenOn) {
        await stopScreenShare();
      } else {
        await startScreenShare(shareOptions);
      }
    } finally {
      shareInflightRef.current = false;
      setShareInflight(false);
    }
  }

  async function leave(): Promise<void> {
    if (room) await room.disconnect();
    playSound('vc-self-leave');
    // Send an empty body — the API client always sets Content-Type:
    // application/json, and Fastify's default parser rejects empty bodies
    // with that header set. `{}` satisfies both sides.
    await api('/voice/leave', { method: 'POST', body: {} }).catch(() => undefined);
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
    // Default to the last entry, which corresponds to the last-joined
    // participant who is currently sharing — not the most-recently-started
    // share, since participants are iterated in join order. If users want
    // a specific presenter, they can pin them.
    return screenSharePublications[screenSharePublications.length - 1] ?? null;
  }, [screenSharePublications, pinnedIdentity]);

  // Clear stale pin when the pinned share ends.
  useEffect(() => {
    if (pinnedIdentity && !screenSharePublications.find((s) => s.participant.identity === pinnedIdentity)) {
      setPinnedIdentity(null);
    }
  }, [pinnedIdentity, screenSharePublications]);

  // Force the share-options popover closed the moment sharing starts. The
  // trigger button is disabled while `screenOn === true`, but if the user
  // had the popover open at the moment they hit the share button, Radix
  // would leave it open with disabled-looking content until they click out.
  useEffect(() => {
    if (screenOn && shareOptionsOpen) setShareOptionsOpen(false);
  }, [screenOn, shareOptionsOpen]);

  const statusLine = (
    <>
      {status === 'connecting' && 'Pulling up a chair…'}
      {status === 'reconnecting' && 'Reconnecting…'}
      {status === 'connected' && `${participants.length} around the table`}
      {status === 'error' && (error ?? 'Could not enter the room.')}
      {status === 'idle' && 'Left the room.'}
    </>
  );

  const controlButtons = (
    <>
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
          disabled={status !== 'connected' || !allowed?.canPublishScreenShare || shareInflight}
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
          disabled={status !== 'connected' || !allowed?.canPublishScreenShare || screenOn || shareInflight}
          value={shareOptions}
          onChange={setShareOptions}
          open={shareOptionsOpen}
          onOpenChange={setShareOptionsOpen}
        />
      </div>
      <div className="relative">
        <button
          type="button"
          className={soundboardOpen ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setSoundboardOpen((v) => !v)}
          disabled={status !== 'connected'}
          aria-pressed={soundboardOpen}
          title="Soundboard"
        >
          <Music size={16} />
        </button>
        {soundboardOpen ? (
          <SoundboardPanel
            serverId={serverId}
            voiceChannelId={channelId}
            onClose={() => setSoundboardOpen(false)}
          />
        ) : null}
      </div>
      <div className="relative">
        <button
          type="button"
          className={whiteboardOpen ? 'btn-primary' : 'btn-ghost'}
          onClick={() => setWhiteboardOpen((v) => !v)}
          disabled={status !== 'connected'}
          aria-pressed={whiteboardOpen}
          title="Whiteboard"
        >
          <Pen size={16} />
        </button>
        {whiteboardOpen ? (
          <Whiteboard
            channelId={channelId}
            serverId={serverId}
            onClose={() => setWhiteboardOpen(false)}
          />
        ) : null}
      </div>
      <CaptionsToggleButton enabled={captionsOn} onToggle={() => setCaptionsOn((v) => !v)} />
      <RecordingControls
        channelId={channelId}
        room={room}
        meId={me?.id ?? ''}
        participantIds={participants.map((p) => p.identity)}
        isHost={isStageHost}
      />
      {isStageHost ? (
        <div className="relative">
          <button
            type="button"
            className={breakoutsOpen ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setBreakoutsOpen((v) => !v)}
            disabled={status !== 'connected'}
            aria-pressed={breakoutsOpen}
            title="Breakouts"
          >
            <Users size={16} />
          </button>
          {breakoutsOpen ? (
            <BreakoutsPanel
              channelId={channelId}
              participants={participants}
              onClose={() => setBreakoutsOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
      {isStage && myStagePosition === 'audience' ? (
        <button
          type="button"
          className={myHandRaisedAt ? 'btn-primary' : 'btn-ghost'}
          onClick={() =>
            void api(`/voice/${channelId}/${myHandRaisedAt ? 'lower-hand' : 'raise-hand'}`, {
              method: 'POST',
            }).catch((err) =>
              toast.error(err instanceof Error ? err.message : 'Could not signal'),
            )
          }
          disabled={status !== 'connected'}
          aria-pressed={!!myHandRaisedAt}
          title={myHandRaisedAt ? 'Lower hand' : 'Raise hand'}
        >
          <Hand size={16} />
        </button>
      ) : null}
      <button
        type="button"
        className="btn-danger"
        onClick={() => void leave()}
        title="Leave the room"
      >
        <PhoneOff size={16} />
      </button>
    </>
  );

  // Minimized: collapse to a single-row bar. The LiveKit Room object lives in
  // component state, so flipping between minimized and expanded keeps the
  // session alive — the user can navigate to a text channel while still in
  // the call, and the camera/mic state is untouched.
  if (minimized) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-subtle bg-sunken px-4 py-2">
        <RecordingConsentDialog channelId={channelId} meId={me?.id ?? null} />
        <button
          type="button"
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:bg-raised px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          title="Open voice room"
        >
          <Volume2 size={16} className="shrink-0 text-fg-muted" />
          <div className="min-w-0">
            <div className="truncate font-serif text-sm font-medium">{channelName}</div>
            <div className="truncate text-xs text-fg-muted">{statusLine}</div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">{controlButtons}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <RecordingConsentDialog channelId={channelId} meId={me?.id ?? null} />
      <header className="flex items-center justify-between border-b border-subtle px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Volume2 size={16} className="text-fg-muted shrink-0" />
          <div className="min-w-0">
            <div className="truncate font-serif font-medium">{channelName}</div>
            <div className="text-xs text-fg-muted">{statusLine}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">{controlButtons}</div>
      </header>

      {shareDropped ? (
        <div className="flex items-center justify-between gap-3 border-b border-subtle bg-tint-ember px-4 py-2 text-sm">
          <span>Your screen share dropped during the reconnect.</span>
          <button
            type="button"
            className="btn-ghost text-fg"
            onClick={() => {
              // Don't clear `shareDropped` optimistically — if the user
              // cancels the screen-picker, we want the banner to stay so
              // they can try again. `LocalTrackPublished` clears it on
              // actual success.
              void toggleScreenShare();
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
          serverId={serverId}
        />
      ) : (
        <div className="relative flex flex-1 flex-col overflow-y-auto">
          {status === 'connected' && !minimized ? (
            <div className="px-4 pt-4">
              <WatchPartyMount channelId={channelId} />
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
            {participants.map((p) => {
              const vs = voiceStatesByUser[p.identity];
              const stageBadge: 'speaker' | 'audience' | null = isStage
                ? (vs?.stagePosition ?? 'audience')
                : null;
              const handRaised = isStage && !!vs?.handRaisedAt;
              const hostActions =
                isStage && isStageHost && p.identity !== me?.id
                  ? {
                      onPromote: () =>
                        void api(`/voice/${channelId}/promote/${p.identity}`, {
                          method: 'POST',
                        }).catch((err) =>
                          toast.error(err instanceof Error ? err.message : 'Promote failed'),
                        ),
                      onDemote: () =>
                        void api(`/voice/${channelId}/demote/${p.identity}`, {
                          method: 'POST',
                        }).catch((err) =>
                          toast.error(err instanceof Error ? err.message : 'Demote failed'),
                        ),
                    }
                  : null;
              return (
                <ParticipantCameraTile
                  key={p.identity}
                  participant={p}
                  serverId={serverId}
                  stageBadge={stageBadge}
                  handRaised={handRaised}
                  hostActions={hostActions}
                  recordingActive={recordingActive}
                />
              );
            })}
            {participants.length === 0 && status === 'connected' ? (
              <div className="col-span-full grid place-items-center text-fg-muted">
                Just you for now.
              </div>
            ) : null}
          </div>
          {status === 'connected' && !minimized ? (
            <CaptionsMount
              channelId={channelId}
              enabled={captionsOn}
              remoteLines={captionLines}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function CaptionsMount({
  channelId,
  enabled,
  remoteLines,
}: {
  channelId: string;
  enabled: boolean;
  remoteLines: ReturnType<typeof useCaptions.getState>['linesByChannel'][string];
}): JSX.Element | null {
  const me = useAuth((s) => s.me);
  if (!me) return null;
  return (
    <LiveCaptions
      channelId={channelId}
      userId={me.id}
      displayName={me.displayName || me.username}
      enabled={enabled}
      remoteLines={remoteLines ?? []}
    />
  );
}

function WatchPartyMount({ channelId }: { channelId: string }): JSX.Element | null {
  const me = useAuth((s) => s.me);
  if (!me) return null;
  return <WatchPartyPanel channelId={channelId} userId={me.id} />;
}

interface PresenterLayoutProps {
  active: { participant: ParticipantAny; pub: TrackPublication };
  participants: ParticipantAny[];
  pinnedIdentity: string | null;
  onTogglePin: (identity: string) => void;
  serverId: string;
}

function PresenterLayout({
  active,
  participants,
  pinnedIdentity,
  onTogglePin,
  serverId,
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
            <ParticipantCameraTile participant={p} serverId={serverId} compact />
          </div>
        ))}
      </div>
    </div>
  );
}

function ParticipantCameraTile({
  participant,
  serverId,
  compact = false,
  stageBadge = null,
  handRaised = false,
  hostActions = null,
  recordingActive = false,
}: {
  participant: ParticipantAny;
  serverId: string;
  compact?: boolean;
  /** Wave 3 #25 — present on stage channels only. */
  stageBadge?: 'speaker' | 'audience' | null;
  handRaised?: boolean;
  hostActions?: { onPromote: () => void; onDemote: () => void } | null;
  /** Wave 3 #32 — show a red dot in the corner while recording is active. */
  recordingActive?: boolean;
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

/**
 * Per-participant local audio volume, in [0, 1]. Persists to localStorage
 * keyed by participant identity so the mix survives reconnects. Returns
 * `null` for participants where setVolume isn't available (local participant
 * or older LiveKit clients) so the caller can hide the slider entirely.
 */
function useVoiceParticipantVolume(
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
