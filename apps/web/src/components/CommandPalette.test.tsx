import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// --- Mocks -----------------------------------------------------------------
// The palette is heavily coupled to the router and the realtime store. Stub
// both so it renders in isolation: navigate is a spy, params are empty, and
// the store serves a fixed snapshot with one tavern + one text room so there's
// a deterministic "jump" result to assert against. The grouping/filtering and
// palette-commands stay real.

const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => ({}),
}));

const storeState = {
  serversById: { srv_1: { id: 'srv_1', name: 'The Keep' } },
  channelsByServer: {
    srv_1: [{ id: 'chan_1', name: 'general', type: 'text' }],
  },
  dmChannelsById: {},
};

vi.mock('../lib/store.js', () => ({
  // Mirrors zustand's selector-hook contract: call the selector with state.
  useRealtime: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

import { CommandPalette } from './CommandPalette.js';

// Open via the global Cmd/Ctrl+K shortcut the component registers on mount.
async function openPalette(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.keyboard('{Control>}k{/Control}');
  await screen.findByRole('combobox');
}

describe('CommandPalette', () => {
  it('exposes combobox/listbox/option semantics once open', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await openPalette(user);

    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-controls', 'command-palette-list');
    // With results present the combobox advertises an expanded popup.
    expect(input).toHaveAttribute('aria-expanded', 'true');

    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('id', 'command-palette-list');

    // Static jump entries alone guarantee multiple options.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
  });

  it('narrows results as you type and tracks the active option', async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);

    await openPalette(user);

    const input = screen.getByRole('combobox');
    await user.type(input, 'general');

    // The seeded room is the matching jump target.
    const option = await screen.findByRole('option', { name: /#general/ });
    expect(option).toHaveAttribute('id');

    // ArrowDown moves the highlight; the input's aria-activedescendant should
    // then point at a real option id in the list.
    await user.keyboard('{ArrowDown}');

    await waitFor(() => {
      const activeId = input.getAttribute('aria-activedescendant');
      expect(activeId).toBeTruthy();
      expect(document.getElementById(activeId as string)).toHaveAttribute('role', 'option');
    });
  });

  it('has no axe violations while open', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<CommandPalette />);

    await openPalette(user);
    // Portalled into the body — audit from baseElement.
    expect(await axe(baseElement)).toHaveNoViolations();
  });
});
