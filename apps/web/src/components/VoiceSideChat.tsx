import { MessageCircle } from 'lucide-react';
import { MessageComposer } from './MessageComposer.js';
import { MessageList } from './MessageList.js';
import { PinsPopover } from './PinsPopover.js';
import { TypingIndicator } from './TypingIndicator.js';

interface Props {
  channelId: string;
  channelName: string;
}

export function VoiceSideChat({ channelId, channelName }: Props): JSX.Element {
  return (
    <aside
      className="flex h-[42vh] min-h-[18rem] min-w-0 flex-col border-t border-subtle bg-canvas xl:h-auto xl:min-h-0 xl:w-[400px] xl:shrink-0 xl:border-l xl:border-t-0"
      aria-label={`${channelName} room chat`}
    >
      <header className="flex items-center gap-2 border-b border-subtle bg-sunken px-3 py-2">
        <MessageCircle size={15} className="shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-sm font-medium">Room chat</div>
          <div className="truncate text-xs text-fg-muted">{channelName}</div>
        </div>
        <PinsPopover channelId={channelId} />
      </header>
      <MessageList channelId={channelId} />
      <TypingIndicator channelId={channelId} />
      <MessageComposer channelId={channelId} />
    </aside>
  );
}
