import type { Message } from '@tavern/shared';

/**
 * Shape we need for a preview — only the fields this helper actually reads.
 * Permissive so both the full `Message` DTO and partial subsets (e.g. the
 * compact inbox mention payload, which doesn't carry the per-die `terms`)
 * can pass through.
 */
export interface PreviewableMessage {
  type?: Message['type'];
  content: string;
  diceRoll?: {
    notation: string;
    total: number;
    label: string | null;
  } | null;
}

/**
 * One-line summary of a message for compact surfaces (inbox, pins, saved
 * search results). For dice rolls we surface the total — "1d20 → 14" — so
 * the preview is meaningful instead of just the formula. Falls back to a
 * dash when there's nothing to show.
 */
export function messagePreview(message: PreviewableMessage): string {
  if (message.type === 'dice_roll' && message.diceRoll) {
    const { notation, total, label } = message.diceRoll;
    const prefix = label ? `${label}: ` : '';
    return `${prefix}${notation} → ${total}`;
  }
  return message.content || '—';
}
