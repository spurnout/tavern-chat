import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// Keep ApiError real (the panel does `instanceof ApiError`) but make the
// network call a spy we can drive per-test.
vi.mock('../lib/api-client.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/api-client.js')>();
  return { ...actual, api: vi.fn() };
});

// The real toast schedules timers and renders nothing here — stub it out so
// rolls/errors don't leak setTimeout work into the test.
vi.mock('../lib/toast.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { api } from '../lib/api-client.js';
import { RandomTablesPanel } from './RandomTablesPanel.js';

const apiMock = vi.mocked(api);

interface TableRow {
  id: string;
  tableId: string;
  rangeMin: number;
  rangeMax: number;
  label: string;
  weight: number;
  resultText: string;
}
interface Table {
  id: string;
  serverId: string;
  campaignId: string | null;
  name: string;
  diceNotation: string;
  ownerId: string;
  createdAt: string;
  rows: TableRow[];
}

function makeTable(over: Partial<Table> = {}): Table {
  return {
    id: 't1',
    serverId: 's1',
    campaignId: null,
    name: 'Wandering monsters',
    diceNotation: '1d6',
    ownerId: 'u1',
    createdAt: new Date().toISOString(),
    rows: [],
    ...over,
  };
}

describe('RandomTablesPanel', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('shows the empty state when the campaign has no tables', async () => {
    apiMock.mockResolvedValue([]);
    render(<RandomTablesPanel serverId="s1" />);

    expect(await screen.findByText('No tables yet.')).toBeInTheDocument();
    expect(
      screen.getByText(/Build one to roll on/i),
    ).toBeInTheDocument();
  });

  it('confirms before deleting and only fires the DELETE on confirm', async () => {
    const user = userEvent.setup();
    const table = makeTable();
    // Initial GET load resolves the seeded table; later calls (the DELETE)
    // resolve to an empty object.
    apiMock.mockImplementation(async (path: string) => {
      if (path === '/servers/s1/tables') return [table] as unknown as never;
      return {} as never;
    });

    render(<RandomTablesPanel serverId="s1" />);

    // Row rendered.
    expect(await screen.findByText('Wandering monsters')).toBeInTheDocument();
    const loadCalls = apiMock.mock.calls.length;

    // Click the row's delete button — confirm dialog should open, no DELETE yet.
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Delete this table?')).toBeInTheDocument();
    expect(
      apiMock.mock.calls.some(([, opts]) => (opts as { method?: string })?.method === 'DELETE'),
    ).toBe(false);
    // Still only the load call(s) so far.
    expect(apiMock.mock.calls.length).toBe(loadCalls);

    // Confirm — exactly one DELETE to the table endpoint should fire.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const deletes = apiMock.mock.calls.filter(
        ([, opts]) => (opts as { method?: string })?.method === 'DELETE',
      );
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.[0]).toBe('/tables/t1');
    });
  });

  it('has no axe violations in the empty state', async () => {
    apiMock.mockResolvedValue([]);
    const { container } = render(<RandomTablesPanel serverId="s1" />);
    await screen.findByText('No tables yet.');
    expect(await axe(container)).toHaveNoViolations();
  });
});
