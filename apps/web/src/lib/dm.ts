import { useNavigate } from '@tanstack/react-router';
import type { DmChannel } from '@tavern/shared';
import { api, ApiError } from './api-client.js';
import { useRealtime } from './store.js';
import { toast } from './toast.js';

type NavigateFn = ReturnType<typeof useNavigate>;

/**
 * Find-or-create a 1:1 DM with `userId` and navigate to it. Idempotent on
 * the API side, so calling this twice with the same userId is safe.
 *
 * Extracted from MemberSidebar so the member-profile card can call it from
 * its "Send a message" action without re-implementing the toast/navigate
 * dance.
 */
export async function startDmWith(
  userId: string,
  navigate: NavigateFn,
): Promise<void> {
  try {
    const dm = await api<DmChannel>('/dms/direct', {
      method: 'POST',
      body: { userId },
    });
    useRealtime.getState().upsertDmChannel(dm);
    void navigate({ to: '/app/dms/$dmChannelId', params: { dmChannelId: dm.id } });
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'Could not start the DM.');
  }
}
