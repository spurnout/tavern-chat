import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { ErrorAlert } from './ErrorAlert.js';

describe('ErrorAlert', () => {
  it('exposes the message through an alert role so it is announced', () => {
    render(<ErrorAlert>That code didn’t match.</ErrorAlert>);
    expect(screen.getByRole('alert')).toHaveTextContent('That code didn’t match.');
  });

  it('layers extra classes over the base error style', () => {
    render(<ErrorAlert className="mt-3">Boom.</ErrorAlert>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('text-danger');
    expect(alert).toHaveClass('mt-3');
  });

  it('has no axe violations', async () => {
    const { container } = render(<ErrorAlert>Something went wrong.</ErrorAlert>);
    expect(await axe(container)).toHaveNoViolations();
  });
});
