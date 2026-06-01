import { create } from 'zustand';
import type { ServerLockdownPayload } from '@tavern/shared';

/**
 * Live raid-lockdown state per tavern (parity gap #4). Updated by the
 * SERVER_LOCKDOWN gateway event so admin surfaces can show a banner without
 * refetching. Not persisted — it hydrates from events + the raid-protection
 * config fetch.
 */
interface LockdownState {
  byServer: Record<string, ServerLockdownPayload>;
  apply: (payload: ServerLockdownPayload) => void;
}

export const useLockdown = create<LockdownState>((set) => ({
  byServer: {},
  apply: (payload) =>
    set((s) => ({ byServer: { ...s.byServer, [payload.serverId]: payload } })),
}));
