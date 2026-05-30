import type { LocalParticipant, RemoteParticipant, TrackPublication } from 'livekit-client';
import { ParticipantCameraTile } from './ParticipantCameraTile.js';
import { ScreenShareTile } from './ScreenShareTile.js';

type ParticipantAny = LocalParticipant | RemoteParticipant;

export interface PresenterLayoutProps {
  active: { participant: ParticipantAny; pub: TrackPublication };
  participants: ParticipantAny[];
  pinnedIdentity: string | null;
  onTogglePin: (identity: string) => void;
  serverId: string;
}

export function PresenterLayout({
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
