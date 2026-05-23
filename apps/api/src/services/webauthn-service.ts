import { prisma } from '@tavern/db';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { ErrorCodes, TavernError, ulid } from '@tavern/shared';
import type { Config } from '../config.js';
import { InMemoryEphemeralStore, type EphemeralStore } from '../lib/ephemeral-store.js';

/**
 * Wave 3 — WebAuthn / passkey second factor.
 *
 * Challenges are short-lived and stored via the injected EphemeralStore.
 * Default backend is `InMemoryEphemeralStore` (fine for single-replica
 * deployments); when Redis is available the app wires in a
 * `RedisEphemeralStore` so a passkey ceremony that lands on a different
 * replica after the start step can still finish on a new one.
 *
 * Credential records hold the raw `credentialId` and the COSE `publicKey`
 * bytes. The `counter` field is monotonically updated on each successful
 * assertion — a stale counter signals a cloned credential and bails the
 * login. Authenticators that always emit counter 0 (some platform passkeys)
 * are tolerated.
 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface PendingChallenge {
  challenge: string;
  purpose: 'registration' | 'authentication';
  /** Subject this challenge is bound to (userId for register, userId for auth). */
  userId: string;
}

function bytesFromBase64Url(input: string): Buffer {
  // Node's Buffer.from supports base64url natively in 16+.
  return Buffer.from(input, 'base64url');
}

function base64UrlFromBytes(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64url');
}

export class WebAuthnService {
  private readonly challenges: EphemeralStore;

  constructor(
    private readonly config: Config,
    challenges?: EphemeralStore,
  ) {
    this.challenges = challenges ?? new InMemoryEphemeralStore();
  }

  private rpId(): string {
    return this.config.WEBAUTHN_RP_ID;
  }

  private rpName(): string {
    return this.config.WEBAUTHN_RP_NAME ?? this.config.APP_NAME;
  }

  private origin(): string {
    return this.config.WEBAUTHN_ORIGIN ?? this.config.WEB_BASE_URL;
  }

  private async storeChallenge(key: string, val: PendingChallenge): Promise<void> {
    await this.challenges.set(key, val, CHALLENGE_TTL_MS);
  }

  /** List a user's enrolled credentials (no public key bytes). */
  async list(userId: string): Promise<
    Array<{ id: string; deviceName: string | null; createdAt: string; lastUsedAt: string | null }>
  > {
    const rows = await prisma.webAuthnCredential.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      deviceName: r.deviceName,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /** Remove a credential the caller owns. */
  async remove(userId: string, credentialRowId: string): Promise<void> {
    const cred = await prisma.webAuthnCredential.findUnique({
      where: { id: credentialRowId },
      select: { userId: true },
    });
    if (!cred || cred.userId !== userId) {
      throw TavernError.notFound('Passkey not found');
    }
    await prisma.webAuthnCredential.delete({ where: { id: credentialRowId } });
  }

  /**
   * Begin enrollment. The returned options are passed verbatim to the
   * browser's `navigator.credentials.create()`. `excludeCredentials` blocks
   * re-enrolling the same authenticator (the browser will surface a clear
   * "this passkey is already registered" message instead of silently
   * succeeding then 409-ing on the unique index).
   */
  async startRegistration(
    userId: string,
    username: string,
    displayName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await prisma.webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });
    const opts = await generateRegistrationOptions({
      rpName: this.rpName(),
      rpID: this.rpId(),
      userID: new TextEncoder().encode(userId),
      userName: username,
      userDisplayName: displayName,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: base64UrlFromBytes(c.credentialId),
        transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });
    await this.storeChallenge(`reg:${userId}`, {
      userId,
      challenge: opts.challenge,
      purpose: 'registration',
    });
    return opts;
  }

  async finishRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    deviceName: string | null,
  ): Promise<{ id: string; deviceName: string | null }> {
    const pending = await this.challenges.get<PendingChallenge>(`reg:${userId}`);
    if (!pending || pending.purpose !== 'registration') {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_CHALLENGE_EXPIRED,
        'Passkey registration challenge expired — start over',
        400,
      );
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
      });
    } catch (err) {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_VERIFICATION_FAILED,
        err instanceof Error ? err.message : 'Verification failed',
        400,
      );
    } finally {
      await this.challenges.delete(`reg:${userId}`);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_VERIFICATION_FAILED,
        'Could not verify the passkey',
        400,
      );
    }
    const info = verification.registrationInfo;
    const row = await prisma.webAuthnCredential.create({
      data: {
        id: ulid(),
        userId,
        credentialId: bytesFromBase64Url(info.credential.id),
        publicKey: Buffer.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: (response.response.transports ?? []) as string[],
        deviceName,
      },
      select: { id: true, deviceName: true },
    });
    return row;
  }

  /**
   * Begin authentication for a specific user (caller resolves identifier →
   * userId, then asks us for the challenge). `allowCredentials` is populated
   * so the browser knows which authenticator the user is expected to use.
   */
  async startAuthentication(userId: string): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    hasCredentials: boolean;
  }> {
    const creds = await prisma.webAuthnCredential.findMany({
      where: { userId },
      select: { credentialId: true, transports: true },
    });
    if (creds.length === 0) {
      // Return a still-shaped options object so callers don't have to branch
      // on "no creds" specifically — the verify path will refuse anyway and
      // we keep enumeration symmetry with the user-doesn't-exist case.
      const opts = await generateAuthenticationOptions({
        rpID: this.rpId(),
        userVerification: 'preferred',
        allowCredentials: [],
      });
      await this.storeChallenge(`auth:${userId}`, {
        userId,
        challenge: opts.challenge,
        purpose: 'authentication',
      });
      return { options: opts, hasCredentials: false };
    }
    const opts = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({
        id: base64UrlFromBytes(c.credentialId),
        transports: (c.transports ?? []) as AuthenticatorTransportFuture[],
      })),
    });
    await this.storeChallenge(`auth:${userId}`, {
      userId,
      challenge: opts.challenge,
      purpose: 'authentication',
    });
    return { options: opts, hasCredentials: true };
  }

  /**
   * Verify the assertion. On success, bumps the stored counter and returns
   * the userId so the caller can issue a session.
   */
  async finishAuthentication(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ userId: string }> {
    const pending = await this.challenges.get<PendingChallenge>(`auth:${userId}`);
    if (!pending || pending.purpose !== 'authentication') {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_CHALLENGE_EXPIRED,
        'Passkey login challenge expired — start over',
        400,
      );
    }
    // Look up the credential by the raw id the browser sent back.
    const credentialIdBytes = bytesFromBase64Url(response.id);
    const cred = await prisma.webAuthnCredential.findUnique({
      where: { credentialId: credentialIdBytes },
      select: {
        id: true,
        userId: true,
        credentialId: true,
        publicKey: true,
        counter: true,
        transports: true,
      },
    });
    if (!cred || cred.userId !== userId) {
      await this.challenges.delete(`auth:${userId}`);
      throw new TavernError(
        ErrorCodes.WEBAUTHN_VERIFICATION_FAILED,
        'Unknown passkey',
        400,
      );
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
        credential: {
          id: base64UrlFromBytes(cred.credentialId),
          publicKey: new Uint8Array(cred.publicKey),
          counter: Number(cred.counter),
          transports: (cred.transports ?? []) as AuthenticatorTransportFuture[],
        },
      });
    } catch (err) {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_VERIFICATION_FAILED,
        err instanceof Error ? err.message : 'Verification failed',
        400,
      );
    } finally {
      await this.challenges.delete(`auth:${userId}`);
    }
    if (!verification.verified) {
      throw new TavernError(
        ErrorCodes.WEBAUTHN_VERIFICATION_FAILED,
        'Could not verify the passkey',
        400,
      );
    }
    await prisma.webAuthnCredential.update({
      where: { id: cred.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date(),
      },
    });
    return { userId: cred.userId };
  }
}
