import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// PinsPopover only reaches for the `api` helper to load pins on open. Stub it
// with an empty list so the panel renders its "nothing pinned" state without
// touching the network.
vi.mock('../lib/api-client.js', () => ({
  api: vi.fn().mockResolvedValue([]),
}));

import { PinsPopover } from './PinsPopover.js';

describe('PinsPopover', () => {
  it('opens the pins dialog from the trigger and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<PinsPopover channelId="chan_1" />);

    // Closed to start — no dialog in the tree.
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Pinned messages' }));

    const dialog = await screen.findByRole('dialog', { name: 'Pinned messages' });
    expect(dialog).toBeInTheDocument();

    // Radix wires Escape-to-close and focus restoration for free.
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('has no axe violations while open', async () => {
    const user = userEvent.setup();
    const { container, baseElement } = render(<PinsPopover channelId="chan_1" />);

    await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
    await screen.findByRole('dialog', { name: 'Pinned messages' });

    // The content is portalled out of `container`, so audit both the trigger
    // root and the portalled dialog via the document body.
    expect(await axe(container)).toHaveNoViolations();
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
