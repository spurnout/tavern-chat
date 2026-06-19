import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import type { Member, Role } from '@tavern/shared';

// The panel imports both `api` and `ApiError` and narrows update failures with
// `err instanceof ApiError`. The mock therefore has to expose a real ApiError
// class — a bare `{ api: vi.fn() }` would make `instanceof` blow up the moment
// a role update rejects. `api` itself is the spy we drive per-test.
vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }
  return { api: vi.fn(), ApiError };
});

import { api } from '../../lib/api-client.js';
import { MembersPanel } from './MembersPanel.js';

const apiMock = vi.mocked(api);

const SERVER_ID = 'srv_1';

function member(over: Partial<Member> = {}): Member {
  return {
    serverId: SERVER_ID,
    userId: 'usr_ada',
    user: {
      id: 'usr_ada',
      displayName: 'Ada Lovelace',
      username: 'ada',
      presence: 'offline',
    },
    nickname: null,
    joinedAt: '2026-01-02T00:00:00.000Z',
    timeoutUntil: null,
    roles: [],
    ...over,
  };
}

function role(over: Partial<Role> = {}): Role {
  return {
    id: 'role_mod',
    serverId: SERVER_ID,
    name: 'Moderator',
    color: 0,
    position: 1,
    permissions: '0',
    mentionable: false,
    hoist: false,
    isEveryone: false,
    ...over,
  };
}

/**
 * Route a resolved/rejected value per endpoint. The panel fans out to
 * `/members` and `/roles` in parallel through the single `api` spy.
 */
function routeApi(opts: {
  members?: () => Promise<Member[]>;
  roles?: () => Promise<Role[]>;
}): void {
  apiMock.mockImplementation((path: string) => {
    if (path.endsWith('/members')) return (opts.members ?? (() => Promise.resolve([])))();
    if (path.endsWith('/roles')) return (opts.roles ?? (() => Promise.resolve([])))();
    return Promise.resolve(undefined as never);
  });
}

describe('MembersPanel', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('shows a loading line while the fetch is in flight', () => {
    routeApi({ members: () => new Promise<Member[]>(() => {}) });
    render(<MembersPanel serverId={SERVER_ID} />);
    expect(screen.getByText(/loading members/i)).toBeInTheDocument();
  });

  it('shows an error line when the fetch fails', async () => {
    routeApi({ members: () => Promise.reject(new Error('boom')) });
    render(<MembersPanel serverId={SERVER_ID} />);
    expect(await screen.findByText(/couldn.t load the members/i)).toBeInTheDocument();
  });

  it('shows the hospitable empty state when there are no members', async () => {
    routeApi({ members: () => Promise.resolve([]), roles: () => Promise.resolve([]) });
    render(<MembersPanel serverId={SERVER_ID} />);
    expect(await screen.findByText(/no other members yet/i)).toBeInTheDocument();
  });

  it('renders a member row once loaded', async () => {
    routeApi({
      members: () => Promise.resolve([member()]),
      roles: () => Promise.resolve([role()]),
    });
    render(<MembersPanel serverId={SERVER_ID} />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // The (non-everyone) role surfaces as a toggle button.
    expect(screen.getByRole('button', { name: 'Moderator' })).toBeInTheDocument();
  });

  it('has no axe violations in the loaded state', async () => {
    routeApi({
      members: () => Promise.resolve([member()]),
      roles: () => Promise.resolve([role()]),
    });
    const { container } = render(<MembersPanel serverId={SERVER_ID} />);
    await screen.findByText('Ada Lovelace');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
