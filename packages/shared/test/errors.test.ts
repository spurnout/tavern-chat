import { describe, expect, it } from 'vitest';
import { TavernError, ErrorCodes } from '../src/errors.js';

describe('TavernError', () => {
  it('stores code, message, statusCode, and details', () => {
    const e = new TavernError(ErrorCodes.CONFLICT, 'dupe', 409, { field: 'x' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('TavernError');
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toBe('dupe');
    expect(e.statusCode).toBe(409);
    expect(e.details).toEqual({ field: 'x' });
  });

  it('toJSON() omits details when undefined', () => {
    const e = new TavernError(ErrorCodes.NOT_FOUND, 'nope', 404);
    expect(e.toJSON()).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'nope' } });
  });

  it('toJSON() includes details when present', () => {
    const e = new TavernError(ErrorCodes.VALIDATION_ERROR, 'bad', 400, [{ path: 'a' }]);
    expect(e.toJSON()).toEqual({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'bad', details: [{ path: 'a' }] },
    });
  });

  it('unauthorized() → 401 / UNAUTHORIZED with a default message', () => {
    const e = TavernError.unauthorized();
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe('UNAUTHORIZED');
    expect(e.message).toBe('Authentication required');
  });

  it('forbidden() → 403 / PERMISSION_DENIED, custom message honored', () => {
    expect(TavernError.forbidden().statusCode).toBe(403);
    expect(TavernError.forbidden().code).toBe('PERMISSION_DENIED');
    expect(TavernError.forbidden('nope').message).toBe('nope');
  });

  it('notFound() → 404 / NOT_FOUND', () => {
    const e = TavernError.notFound('gone');
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('gone');
  });

  it('conflict() → 409 with the supplied code', () => {
    const e = TavernError.conflict(ErrorCodes.USERNAME_TAKEN, 'taken');
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe('USERNAME_TAKEN');
  });

  it('validation() → 400 / VALIDATION_ERROR and carries details', () => {
    const e = TavernError.validation('bad input', { issues: 1 });
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.details).toEqual({ issues: 1 });
    // default message + no details when omitted
    expect(TavernError.validation().message).toBe('Invalid input');
    expect(TavernError.validation().toJSON().error.details).toBeUndefined();
  });

  it('rateLimited() → 429 / RATE_LIMITED', () => {
    expect(TavernError.rateLimited().statusCode).toBe(429);
    expect(TavernError.rateLimited().code).toBe('RATE_LIMITED');
  });

  it('internal() → 500 / INTERNAL_ERROR', () => {
    expect(TavernError.internal().statusCode).toBe(500);
    expect(TavernError.internal().code).toBe('INTERNAL_ERROR');
  });

  it('is throwable and catchable as an Error', () => {
    try {
      throw TavernError.notFound();
    } catch (err) {
      expect(err).toBeInstanceOf(TavernError);
      expect(err).toBeInstanceOf(Error);
      expect((err as TavernError).statusCode).toBe(404);
    }
  });
});
