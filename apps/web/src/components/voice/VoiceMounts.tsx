import { useAuth } from '../../lib/auth.js';
import { LiveCaptions } from '../LiveCaptions.js';
import { WatchPartyPanel } from '../WatchPartyPanel.js';
import type { CaptionLine } from '../../lib/captions-store.js';

export function CaptionsMount({
  channelId,
  enabled,
  remoteLines,
}: {
  channelId: string;
  enabled: boolean;
  remoteLines: CaptionLine[];
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

export function WatchPartyMount({ channelId }: { channelId: string }): JSX.Element | null {
  const me = useAuth((s) => s.me);
  if (!me) return null;
  return <WatchPartyPanel channelId={channelId} userId={me.id} />;
}
