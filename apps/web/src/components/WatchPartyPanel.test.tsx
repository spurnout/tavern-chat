import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// Mock the network layer (`api`) but keep a real `ApiError` class so the
// component's `instanceof ApiError` branches behave. `toast` is mocked so its
// setTimeout-driven store doesn't leak across tests. `vi.hoisted` lets the spy
// be declared before the hoisted `vi.mock` factory captures it.
const { api } = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock('../lib/api-client.js', () => ({
  api,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../lib/toast.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { WatchPartyPanel } from './WatchPartyPanel.js';

const HOST_ID = 'user-host-000000';

const hostParty = {
  id: 'wp-1',
  channelId: 'chan-1',
  hostUserId: HOST_ID,
  videoUrl: 'https://example.test/clip.mp4',
  source: 'mp4',
  startedAt: new Date().toISOString(),
  currentSec: 0,
  isPlaying: false,
  lastUpdatedAt: new Date().toISOString(),
};

const DELETE_CALL = ['/watch-party/wp-1', { method: 'DELETE' }] as const;

/**
 * Render as the host with an active party loaded. The panel double-fetches on
 * load (mount + the effect re-run when `party` flips non-null) and polls every
 * 5s, so the GET must resolve the party on EVERY call — otherwise `party`
 * clears and the host controls vanish. Mutations (DELETE/PATCH/POST) carry an
 * options arg; the bare GET does not.
 */
async function renderAsHost(): Promise<void> {
  api.mockImplementation((_path: string, opts?: { method?: string }) =>
    Promise.resolve(opts ? undefined : hostParty),
  );
  render(<WatchPartyPanel channelId="chan-1" userId={HOST_ID} />);
  await screen.findByLabelText('End party');
}

describe('WatchPartyPanel', () => {
  beforeEach(() => {
    api.mockReset();
  });

  it('confirms before ending the party instead of firing immediately', async () => {
    const user = userEvent.setup();
    await renderAsHost();

    // The header "End party" button opens a confirm — it must NOT delete yet.
    // findBy (retry) rides out the brief loading-flicker: the panel renders
    // null while any refresh is in flight, and it double-fetches on mount.
    await user.click(await screen.findByLabelText('End party'));
    expect(
      await screen.findByRole('heading', { name: 'End the watch party?' }),
    ).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(...DELETE_CALL);

    // Confirming (the dialog's "End party" button, scoped to disambiguate it
    // from the header button that shares the name) fires the DELETE.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'End party' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(...DELETE_CALL));
  });

  it('cancelling the end-party dialog leaves the party untouched', async () => {
    const user = userEvent.setup();
    await renderAsHost();

    // findBy (retry) rides out the brief loading-flicker: the panel renders
    // null while any refresh is in flight, and it double-fetches on mount.
    await user.click(await screen.findByLabelText('End party'));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'End the watch party?' }),
      ).not.toBeInTheDocument(),
    );
    expect(api).not.toHaveBeenCalledWith(...DELETE_CALL);
  });

  it('has no axe violations with the confirm dialog open', async () => {
    const user = userEvent.setup();
    await renderAsHost();
    // findBy (retry) rides out the brief loading-flicker: the panel renders
    // null while any refresh is in flight, and it double-fetches on mount.
    await user.click(await screen.findByLabelText('End party'));
    const dialog = await screen.findByRole('dialog');
    // Scope to the dialog: the host view also renders a <video> whose missing
    // captions are a separate, out-of-scope concern.
    expect(await axe(dialog)).toHaveNoViolations();
  }, 20000);
});
