import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// AuditTab fetches the log on mount; stub the client with an empty list so the
// component settles into its empty state without touching the network.
vi.mock('../../lib/api-client.js', () => ({
  api: vi.fn().mockResolvedValue([]),
  ApiError: class ApiError extends Error {},
}));

import { AuditTab } from './AuditTab.js';

describe('AuditTab category filter', () => {
  it('renders the category filter as a radiogroup, not a tablist', async () => {
    const user = userEvent.setup();
    render(<AuditTab serverId="srv_1" />);
    await screen.findByText('No audit entries yet.');

    // The pills are a single-select filter over one in-place list — radiogroup
    // semantics, not the (previously mislabeled) tabs.
    expect(
      screen.getByRole('radiogroup', { name: 'Filter audit log by category' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);

    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(1);

    // "All actions" is the default selection.
    const all = screen.getByRole('radio', { name: 'All actions' });
    const moderation = screen.getByRole('radio', { name: 'Moderation' });
    expect(all).toBeChecked();
    expect(moderation).not.toBeChecked();

    // Selecting another category moves the single selection.
    await user.click(moderation);
    expect(moderation).toBeChecked();
    expect(all).not.toBeChecked();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AuditTab serverId="srv_1" />);
    await screen.findByText('No audit entries yet.');
    expect(await axe(container)).toHaveNoViolations();
  });
});
