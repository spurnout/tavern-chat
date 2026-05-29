import { describe, expect, it } from 'vitest';
import {
  webauthnLoginFinishSchema,
  webauthnLoginStartSchema,
  webauthnRegisterFinishSchema,
  webauthnRegisterStartSchema,
} from '../src/schemas/webauthn.js';

describe('webauthnRegisterStartSchema', () => {
  it('accepts an empty body (deviceName optional)', () => {
    expect(webauthnRegisterStartSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a deviceName', () => {
    expect(
      webauthnRegisterStartSchema.safeParse({ deviceName: 'MacBook TouchID' }).success,
    ).toBe(true);
  });

  it('rejects a deviceName over 120 chars', () => {
    expect(
      webauthnRegisterStartSchema.safeParse({ deviceName: 'x'.repeat(121) }).success,
    ).toBe(false);
  });

  it('rejects a non-string deviceName', () => {
    expect(webauthnRegisterStartSchema.safeParse({ deviceName: 123 }).success).toBe(false);
  });
});

describe('webauthnRegisterFinishSchema', () => {
  it('accepts a response of any shape (unknown) with no deviceName', () => {
    expect(
      webauthnRegisterFinishSchema.safeParse({ response: { id: 'cred', rawId: 'x' } }).success,
    ).toBe(true);
  });

  it('accepts response plus deviceName', () => {
    expect(
      webauthnRegisterFinishSchema.safeParse({ response: {}, deviceName: 'YubiKey' }).success,
    ).toBe(true);
  });

  it('accepts a null response (unknown permits null)', () => {
    expect(webauthnRegisterFinishSchema.safeParse({ response: null }).success).toBe(true);
  });

  it('accepts a missing response key (z.unknown is optional)', () => {
    // The library does the structural validation; schema is deliberately
    // permissive, so an absent response field still parses.
    expect(webauthnRegisterFinishSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a deviceName over 120 chars', () => {
    expect(
      webauthnRegisterFinishSchema.safeParse({ response: {}, deviceName: 'x'.repeat(121) })
        .success,
    ).toBe(false);
  });
});

describe('webauthnLoginStartSchema', () => {
  it('accepts a username identifier', () => {
    expect(webauthnLoginStartSchema.safeParse({ identifier: 'ash' }).success).toBe(true);
  });

  it('accepts an email identifier', () => {
    expect(
      webauthnLoginStartSchema.safeParse({ identifier: 'ash@example.com' }).success,
    ).toBe(true);
  });

  it('rejects an empty identifier', () => {
    expect(webauthnLoginStartSchema.safeParse({ identifier: '' }).success).toBe(false);
  });

  it('rejects an identifier over 254 chars', () => {
    expect(
      webauthnLoginStartSchema.safeParse({ identifier: 'x'.repeat(255) }).success,
    ).toBe(false);
  });

  it('rejects a missing identifier', () => {
    expect(webauthnLoginStartSchema.safeParse({}).success).toBe(false);
  });
});

describe('webauthnLoginFinishSchema', () => {
  it('accepts a valid stagedToken plus response', () => {
    expect(
      webauthnLoginFinishSchema.safeParse({ stagedToken: 'abcd1234', response: {} }).success,
    ).toBe(true);
  });

  it('rejects a stagedToken shorter than 8 chars', () => {
    expect(
      webauthnLoginFinishSchema.safeParse({ stagedToken: 'short', response: {} }).success,
    ).toBe(false);
  });

  it('accepts a missing response key (z.unknown is optional)', () => {
    expect(webauthnLoginFinishSchema.safeParse({ stagedToken: 'abcd1234' }).success).toBe(true);
  });

  it('rejects a missing stagedToken', () => {
    expect(webauthnLoginFinishSchema.safeParse({ response: {} }).success).toBe(false);
  });
});
