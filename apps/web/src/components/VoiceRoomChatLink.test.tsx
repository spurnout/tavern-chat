import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// VoiceRoomChatLink renders a TanStack Router <Link>. Stub the router module so
// <Link> becomes a plain anchor that echoes its destination — this lets us
// assert WHICH route the icon targets without standing up a RouterProvider.
// The whole point of the feature is that this opens the room *chat* route, not
// the *voice* route, so the destination is the behaviour worth pinning down.
interface MockLinkProps {
  to: string;
  params?: Record<string, string>;
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  title?: string;
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: MockLinkProps) => (
    <a href={to} data-params={JSON.stringify(params)} {...rest}>
      {children}
    </a>
  ),
}));

import { VoiceRoomChatLink } from './VoiceRoomChatLink.js';

describe('VoiceRoomChatLink', () => {
  it('opens the room chat route (not the voice route)', () => {
    render(<VoiceRoomChatLink serverId="srv_1" channelId="chan_voice" />);

    const link = screen.getByRole('link', { name: 'Open room chat' });
    // The text-room route is what renders chat without a voice connection.
    expect(link).toHaveAttribute('href', '/app/servers/$serverId/channels/$channelId');
    expect(link).toHaveAttribute(
      'data-params',
      JSON.stringify({ serverId: 'srv_1', channelId: 'chan_voice' }),
    );
  });
});
