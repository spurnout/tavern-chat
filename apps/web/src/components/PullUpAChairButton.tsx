import { Link } from '@tanstack/react-router';
import { Armchair } from 'lucide-react';

interface Props {
  serverId: string;
  channelId: string;
}

/**
 * Voice-entry CTA shown in a voice room's chat header. When you're reading a
 * voice room's chat without being in the call, this routes you into the call
 * (the voice route). Uses Tavern's "pull up a chair" phrasing — never "join".
 */
export function PullUpAChairButton({ serverId, channelId }: Props): JSX.Element {
  return (
    <Link
      to="/app/servers/$serverId/voice/$channelId"
      params={{ serverId, channelId }}
      className="touch-target inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm font-medium text-ember transition-base hover:bg-tint-ember focus:outline-none focus-visible:ring-1 focus-visible:ring-ember"
    >
      <Armchair size={14} aria-hidden />
      Pull up a chair
    </Link>
  );
}
