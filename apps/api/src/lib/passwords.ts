import argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 1 << 16, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

/**
 * Optional structured-logger injection point (SEC-011). The auth flow calls
 * `verifyPassword` from inside Fastify request handlers where `app.log` is
 * available; the app wires this up at startup so any argon2 engine failures
 * land in the pino stream instead of stderr. Default is a no-op so non-API
 * consumers (seed scripts, tests) don't need to configure anything.
 */
let passwordLog: (msg: { event: string; err: string }) => void = () => {};

export function setPasswordLogger(fn: (msg: { event: string; err: string }) => void): void {
  passwordLog = fn;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch (err) {
    // argon2.verify only throws on malformed hashes or engine failures
    // (OOM, native binding issues) — never on a simple password mismatch.
    // Fail closed but log so infrastructure problems are visible.
    const message = err instanceof Error ? err.message : String(err);
    passwordLog({ event: 'argon2.verify_failed', err: message });
    return false;
  }
}
