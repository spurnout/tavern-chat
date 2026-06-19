import type { LocalParticipant, RemoteParticipant } from 'livekit-client';
import { ParticipantCameraTile } from './ParticipantCameraTile.js';
import { CaptionsMount, WatchPartyMount } from './VoiceMounts.js';
import type { CaptionLine } from '../../lib/captions-store.js';

type ParticipantAny = LocalParticipant | RemoteParticipant;

export interface ParticipantRowData {
  participant: ParticipantAny;
  stageBadge: 'speaker' | 'audience' | null;
  handRaised: boolean;
  hostActions: { onPromote: () => void; onDemote: () => void } | null;
}

export interface VoiceParticipantGridProps {
  channelId: string;
  serverId: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'error' | 'idle';
  minimized: boolean;
  rows: ParticipantRowData[];
  recordingActive: boolean;
  captionsOn: boolean;
  captionLines: CaptionLine[];
}

export function VoiceParticipantGrid({
  channelId,
  serverId,
  status,
  minimized,
  rows,
  recordingActive,
  captionsOn,
  captionLines,
}: VoiceParticipantGridProps): JSX.Element {
  return (
    <div className="relative flex flex-1 flex-col overflow-y-auto">
      {status === 'connected' && !minimized ? (
        <div className="px-4 pt-4">
          <WatchPartyMount channelId={channelId} />
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {rows.map(({ participant, stageBadge, handRaised, hostActions }) => (
          <ParticipantCameraTile
            key={participant.identity}
            participant={participant}
            serverId={serverId}
            stageBadge={stageBadge}
            handRaised={handRaised}
            hostActions={hostActions}
            recordingActive={recordingActive}
          />
        ))}
        {rows.length === 0 && status === 'connected' ? (
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
  );
}
