import { create } from 'zustand';
import type { BlockedUser } from '@tavern/shared';
import { api } from './api-client.js';

/**
 * Blocked-members store (Discord parity gap #1).
 *
 * Hydrated once on realtime start from GET /users/me/blocks and kept in sync
 * by the user-targeted BLOCK_ADD / BLOCK_REMOVE gateway events (delivered only
 * to the blocker). Drives client-side collapse of blocked authors' messages
 * and reactions — the server keeps channel fan-out symmetric so the blocked
 * member is unaware.
 */
interface BlocksState {
  blockedById: Record<string, BlockedUser>;
  loaded: boolean;

  hydrate: () => Promise<void>;
  block: (userId: string) => Promise<void>;
  unblock: (userId: string) => Promise<void>;
  /** Gateway BLOCK_ADD handler. */
  onBlockAdd: (dto: BlockedUser) => void;
  /** Gateway BLOCK_REMOVE handler. */
  onBlockRemove: (userId: string) => void;
}

export const useBlocks = create<BlocksState>((set) => ({
  blockedById: {},
  loaded: false,

  hydrate: async () => {
    try {
      const list = await api<BlockedUser[]>('/users/me/blocks');
      const byId: Record<string, BlockedUser> = {};
      for (const b of list) byId[b.userId] = b;
      set({ blockedById: byId, loaded: true });
    } catch {
      // Best-effort — collapse just won't apply until the next hydrate.
    }
  },

  block: async (userId) => {
    // Optimistic + authoritative: the PUT returns the canonical DTO, and the
    // BLOCK_ADD event keeps other tabs in sync. Re-applying the same row is a
    // no-op, so the event landing after this resolves is harmless.
    const dto = await api<BlockedUser>(`/users/${userId}/block`, { method: 'PUT' });
    set((s) => ({ blockedById: { ...s.blockedById, [dto.userId]: dto } }));
  },

  unblock: async (userId) => {
    await api(`/users/${userId}/block`, { method: 'DELETE' });
    set((s) => {
      const next = { ...s.blockedById };
      delete next[userId];
      return { blockedById: next };
    });
  },

  onBlockAdd: (dto) => {
    set((s) => ({ blockedById: { ...s.blockedById, [dto.userId]: dto } }));
  },

  onBlockRemove: (userId) => {
    set((s) => {
      if (!s.blockedById[userId]) return s;
      const next = { ...s.blockedById };
      delete next[userId];
      return { blockedById: next };
    });
  },
}));

/** Convenience selector — true if `userId` is blocked by the current user. */
export function useIsBlocked(userId: string | null | undefined): boolean {
  return useBlocks((s) => (userId ? s.blockedById[userId] != null : false));
}
