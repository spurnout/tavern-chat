import { create } from 'zustand';

/**
 * Wave 3 #33 — Live captions store.
 *
 * Maintains the recent caption lines for each voice channel. Lines auto-age
 * out after 15s so the overlay stays current; final lines age out at the
 * same rate so a transient utterance vanishes naturally.
 *
 * Sized for short retention — this is a live overlay, not a transcript log.
 * Persistence (CaptionSegment table) is a documented follow-up.
 */

export interface CaptionLine {
  userId: string;
  displayName: string;
  text: string;
  isFinal: boolean;
  at: number;
}

const TTL_MS = 15_000;
const MAX_LINES_PER_CHANNEL = 32;

interface CaptionsState {
  linesByChannel: Record<string, CaptionLine[]>;
  appendLine: (channelId: string, line: CaptionLine) => void;
  prune: () => void;
}

export const useCaptions = create<CaptionsState>((set, get) => ({
  linesByChannel: {},
  appendLine: (channelId, line) => {
    set((s) => {
      const existing = s.linesByChannel[channelId] ?? [];
      // Coalesce: if the last line is from the same user and not final,
      // replace it in-place rather than letting interim chunks pile up.
      const last = existing[existing.length - 1];
      let next: CaptionLine[];
      if (last && last.userId === line.userId && !last.isFinal) {
        next = [...existing.slice(0, -1), line];
      } else {
        next = [...existing, line];
      }
      // Cap so a runaway emitter can't blow memory.
      if (next.length > MAX_LINES_PER_CHANNEL) {
        next = next.slice(-MAX_LINES_PER_CHANNEL);
      }
      return { linesByChannel: { ...s.linesByChannel, [channelId]: next } };
    });
  },
  prune: () => {
    const now = Date.now();
    const next: Record<string, CaptionLine[]> = {};
    let changed = false;
    for (const [channelId, lines] of Object.entries(get().linesByChannel)) {
      const filtered = lines.filter((l) => now - l.at < TTL_MS);
      if (filtered.length !== lines.length) changed = true;
      if (filtered.length > 0) next[channelId] = filtered;
      else changed = true;
    }
    if (changed) set({ linesByChannel: next });
  },
}));

if (typeof window !== 'undefined') {
  // Periodic prune keeps the overlay's render cheap. 2s tick is invisible
  // to the user and well under the TTL.
  setInterval(() => useCaptions.getState().prune(), 2000);
}
