import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

// The modal fetches edit history on mount. Stub the API client so the render
// is deterministic and never touches the network. ApiError is referenced in a
// catch branch, so keep it exported as a usable class.
vi.mock('../lib/api-client.js', () => ({
  api: vi.fn().mockResolvedValue([]),
  ApiError: class ApiError extends Error {},
}));

import { MessageEditHistoryModal } from './MessageEditHistoryModal.js';

describe('MessageEditHistoryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the title', () => {
    render(
      <MessageEditHistoryModal messageId="m1" currentContent="hello" onClose={vi.fn()} />,
    );
    expect(screen.getByText('Edit history')).toBeInTheDocument();
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(
      <MessageEditHistoryModal messageId="m1" currentContent="hello" onClose={onClose} />,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MessageEditHistoryModal messageId="m1" currentContent="hello" onClose={vi.fn()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
