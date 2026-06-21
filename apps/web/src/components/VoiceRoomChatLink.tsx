import { Link } from '@tanstack/react-router';
import { MessageCircle } from 'lucide-react';

interface Props {
  serverId: string;
  channelId: string;
}

/**
 * Hover-revealed chat affordance on a voice room row in the sidebar. Opens the
 * room's text chat via the normal text-room route, which mounts no voice/LiveKit
 * connection — so members can read and post without pulling up a chair (Discord's
 * voice-channel text chat).
 *
 * Revealed via opacity rather than `hidden` so it reserves its slot and the row
 * name doesn't reflow on hover. `pointer-events-none` while hidden stops an
 * invisible target from stealing clicks meant for the row's join link. On touch
 * (no hover) and on keyboard focus it stays visible and interactive.
 */
export function VoiceRoomChatLink({ serverId, channelId }: Props): JSX.Element {
  return (
    <Link
      to="/app/servers/$serverId/channels/$channelId"
      params={{ serverId, channelId }}
      aria-label="Open room chat"
      title="Open room chat"
      className={[
        'mr-1 shrink-0 touch-target-sq rounded p-1 text-fg-muted transition-base hover:bg-raised hover:text-fg',
        'pointer-events-none opacity-0',
        'group-hover:pointer-events-auto group-hover:opacity-100',
        'focus-visible:pointer-events-auto focus-visible:opacity-100',
        '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
      ].join(' ')}
    >
      <MessageCircle size={14} aria-hidden />
    </Link>
  );
}
