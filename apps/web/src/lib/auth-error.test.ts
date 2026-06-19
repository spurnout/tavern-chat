import { describe, it, expect } from 'vitest';
import { ApiError } from './api-client.js';
import { authErrorMessage, TAVERN_UNREACHABLE } from './auth-error.js';

describe('authErrorMessage', () => {
  it('maps 5xx server failures to a friendly, recoverable message', () => {
    expect(
      authErrorMessage(new ApiError('INTERNAL', 'Internal server error', 500), 'Login failed'),
    ).toBe(TAVERN_UNREACHABLE);
    expect(
      authErrorMessage(new ApiError('BAD_GATEWAY', 'upstream down', 502), 'Login failed'),
    ).toBe(TAVERN_UNREACHABLE);
  });

  it('passes 4xx messages through as the API worded them', () => {
    expect(
      authErrorMessage(new ApiError('UNAUTHORIZED', 'Invalid username or password.', 401), 'Login failed'),
    ).toBe('Invalid username or password.');
    expect(
      authErrorMessage(
        new ApiError('NOT_FOUND', 'No passkey is registered for this account.', 404),
        'Passkey sign-in failed',
      ),
    ).toBe('No passkey is registered for this account.');
  });

  it('falls back to the caller default for non-API (network / unexpected) errors', () => {
    expect(authErrorMessage(new TypeError('Failed to fetch'), 'Login failed')).toBe('Login failed');
    expect(authErrorMessage(new Error('weird'), 'Setup failed')).toBe('Setup failed');
  });
});
