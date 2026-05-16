import { CornerDownRight } from 'lucide-react';

interface Props {
  authorDisplayName: string;
  contentExcerpt: string;
  deleted: boolean;
  onClickParent?: () => void;
}

/**
 * Inline parent-message preview rendered above any reply. Clicking scrolls
 * to the parent in the same channel; deleted parents render as an italic
 * placeholder.
 */
export function ReplyContext({
  authorDisplayName,
  contentExcerpt,
  deleted,
  onClickParent,
}: Props): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClickParent}
      className="flex w-full items-center gap-1 truncate text-xs text-fg-muted hover:text-fg"
      title="Jump to original message"
    >
      <CornerDownRight size={12} className="shrink-0" />
      <span className="shrink-0 font-medium">{authorDisplayName}</span>
      <span className="truncate">
        {deleted ? <em>message deleted</em> : contentExcerpt || <em>(no text)</em>}
      </span>
    </button>
  );
}
