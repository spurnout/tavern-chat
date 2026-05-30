import type { Room, LocalParticipant, RemoteParticipant } from 'livekit-client';
import {
  Hand,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Music,
  Pen,
  PhoneOff,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import { ScreenShareSettingsPopover } from '../ScreenShareSettingsPopover.js';
import { SoundboardPanel } from '../SoundboardPanel.js';
import { BreakoutsPanel } from '../BreakoutsPanel.js';
import { RecordingControls } from '../RecordingControls.js';
import { Whiteboard } from '../Whiteboard.js';
import { CaptionsToggleButton } from '../LiveCaptions.js';
import type { ScreenShareOptions } from '../VoiceRoom.js';

type ParticipantAny = LocalParticipant | RemoteParticipant;

export interface VoiceControlBarProps {
  // Connection state
  status: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'idle';
  room: Room | null;
  allowed: {
    canPublishAudio: boolean;
    canPublishVideo: boolean;
    canPublishScreenShare: boolean;
    canSubscribe: boolean;
  } | null;
  participants: ParticipantAny[];

  // Mic/camera/screen state
  muted: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  shareInflight: boolean;
  shareOptions: ScreenShareOptions;
  shareOptionsOpen: boolean;

  // Panel open/close state
  soundboardOpen: boolean;
  whiteboardOpen: boolean;
  captionsOn: boolean;
  breakoutsOpen: boolean;

  // Stage state
  isStage: boolean;
  isStageHost: boolean;
  myStagePosition: string | null;
  myHandRaisedAt: string | null;

  // Identity
  channelId: string;
  serverId: string;
  meId: string;

  // Callbacks — media toggles
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;

  // Callbacks — panel toggles
  onSoundboardToggle: () => void;
  onWhiteboardToggle: () => void;
  onCaptionsToggle: () => void;
  onBreakoutsToggle: () => void;

  // Share options callbacks
  onShareOptionsChange: (opts: ScreenShareOptions) => void;
  onShareOptionsOpenChange: (open: boolean) => void;

  // Stage callbacks
  onRaiseHand: () => void;
  onLowerHand: () => void;
}

export function VoiceControlBar({
  status,
  room,
  allowed,
  participants,
  muted,
  cameraOn,
  screenOn,
  shareInflight,
  shareOptions,
  shareOptionsOpen,
  soundboardOpen,
  whiteboardOpen,
  captionsOn,
  breakoutsOpen,
  isStage,
  isStageHost,
  myStagePosition,
  myHandRaisedAt,
  channelId,
  serverId,
  meId,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
  onSoundboardToggle,
  onWhiteboardToggle,
  onCaptionsToggle,
  onBreakoutsToggle,
  onShareOptionsChange,
  onShareOptionsOpenChange,
  onRaiseHand,
  onLowerHand,
}: VoiceControlBarProps): JSX.Element {
  return (
    <>
      <button
        type="button"
        className={muted ? 'btn-ghost' : 'btn-primary'}
        onClick={onToggleMic}
        disabled={status !== 'connected'}
        aria-pressed={!muted}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button
        type="button"
        className={cameraOn ? 'btn-primary' : 'btn-ghost'}
        onClick={onToggleCamera}
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
          onClick={onToggleScreenShare}
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
          onChange={onShareOptionsChange}
          open={shareOptionsOpen}
          onOpenChange={onShareOptionsOpenChange}
        />
      </div>
      <div className="relative">
        <button
          type="button"
          className={soundboardOpen ? 'btn-primary' : 'btn-ghost'}
          onClick={onSoundboardToggle}
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
            onClose={onSoundboardToggle}
          />
        ) : null}
      </div>
      <div className="relative">
        <button
          type="button"
          className={whiteboardOpen ? 'btn-primary' : 'btn-ghost'}
          onClick={onWhiteboardToggle}
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
            onClose={onWhiteboardToggle}
          />
        ) : null}
      </div>
      <CaptionsToggleButton enabled={captionsOn} onToggle={onCaptionsToggle} />
      <RecordingControls
        channelId={channelId}
        room={room}
        meId={meId}
        participantIds={participants.map((p) => p.identity)}
        isHost={isStageHost}
      />
      {isStageHost ? (
        <div className="relative">
          <button
            type="button"
            className={breakoutsOpen ? 'btn-primary' : 'btn-ghost'}
            onClick={onBreakoutsToggle}
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
              onClose={onBreakoutsToggle}
            />
          ) : null}
        </div>
      ) : null}
      {isStage && myStagePosition === 'audience' ? (
        <button
          type="button"
          className={myHandRaisedAt ? 'btn-primary' : 'btn-ghost'}
          onClick={myHandRaisedAt ? onLowerHand : onRaiseHand}
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
        onClick={onLeave}
        title="Leave the room"
      >
        <PhoneOff size={16} />
      </button>
    </>
  );
}
