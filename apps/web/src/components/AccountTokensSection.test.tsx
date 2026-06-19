import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// The component imports `{ api, ApiError }` from this module. We mock `api`
// so no real network happens, and keep a real-enough `ApiError` so the
// component's `err instanceof ApiError` branches still behave.
vi.mock('../lib/api-client.js', () => ({
  api: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

import { api } from '../lib/api-client.js';
import { AccountTokensSection } from './AccountTokensSection.js';

const mockedApi = vi.mocked(api);

const TOKEN = {
  id: 'tok_1',
  label: 'CI deploy bot',
  scopes: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
};

/**
 * Drive `api` by request shape: the mount GET (`/me/tokens`, no options)
 * resolves the seed row; the revoke DELETE resolves undefined. Returns the
 * mock so individual tests can assert on the calls.
 */
function seedOneToken(): void {
  mockedApi.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/me/tokens' && (!opts || opts.method === undefined)) {
      return Promise.resolve([TOKEN]) as Promise<unknown>;
    }
    // DELETE /me/tokens/:id and anything else
    return Promise.resolve(undefined) as Promise<unknown>;
  });
}

describe('AccountTokensSection', () => {
  beforeEach(() => {
    mockedApi.mockReset();
  });

  it('opens a confirm dialog on Revoke without firing the DELETE yet', async () => {
    const user = userEvent.setup();
    seedOneToken();
    render(<AccountTokensSection />);

    // Wait for the seeded row to render (mount GET resolved).
    await screen.findByText('CI deploy bot');

    // Exactly one call so far: the mount GET. No DELETE.
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi).toHaveBeenCalledWith('/me/tokens');

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    // The confirm dialog is now up…
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Revoke this token?');

    // …and crucially nothing was deleted by merely opening it.
    expect(mockedApi).toHaveBeenCalledTimes(1);
    expect(mockedApi).not.toHaveBeenCalledWith(
      expect.stringContaining('/me/tokens/'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('fires the DELETE only after confirming', async () => {
    const user = userEvent.setup();
    seedOneToken();
    render(<AccountTokensSection />);
    await screen.findByText('CI deploy bot');

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog');

    // The confirm button inside the dialog also reads "Revoke" — scope to it.
    const { getByRole } = within(dialog);
    await user.click(getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith('/me/tokens/tok_1', { method: 'DELETE' });
    });
    // One DELETE, fired exactly once.
    const deleteCalls = mockedApi.mock.calls.filter(
      ([p, o]) => p === '/me/tokens/tok_1' && (o as { method?: string } | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('has no axe violations in its resting state', async () => {
    seedOneToken();
    const { container } = render(<AccountTokensSection />);
    await screen.findByText('CI deploy bot');
    expect(await axe(container)).toHaveNoViolations();
  });
});
