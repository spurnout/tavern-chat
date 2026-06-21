import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// Same router stub as the other link components: <Link> becomes a plain anchor
// echoing its destination so we can assert the route target. This button is the
// inverse of VoiceRoomChatLink — from the chat view it must route INTO the
// voice call (the voice route), so that destination is the behaviour to pin.
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

import { PullUpAChairButton } from './PullUpAChairButton.js';

describe('PullUpAChairButton', () => {
  it('routes into the voice call (the voice route)', () => {
    render(<PullUpAChairButton serverId="srv_1" channelId="chan_voice" />);

    const link = screen.getByRole('link', { name: 'Pull up a chair' });
    expect(link).toHaveAttribute('href', '/app/servers/$serverId/voice/$channelId');
    expect(link).toHaveAttribute(
      'data-params',
      JSON.stringify({ serverId: 'srv_1', channelId: 'chan_voice' }),
    );
  });
});
