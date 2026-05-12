#!/usr/bin/env node
/**
 * Bootstrap .env at the workspace root if it doesn't exist.
 *
 * Runs automatically as `predev` before `pnpm dev`, so a fresh checkout's
 * first `pnpm dev` self-heals instead of crashing on missing config.
 *
 * Behaviour:
 *   - .env exists  → do nothing (never overwrites)
 *   - .env missing → copy .env.example, replace the JWT secret placeholders
 *                    with `crypto.randomBytes(48).toString('hex')`, write.
 *
 * Cross-platform; pure Node, no shell dependencies.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

if (existsSync(ENV_PATH)) {
  // Nothing to do. Don't print anything — predev should be silent on the
  // happy path so it doesn't drown out the real dev output.
  process.exit(0);
}

if (!existsSync(EXAMPLE_PATH)) {
  console.error(
    `[ensure-env] No .env.example found at ${EXAMPLE_PATH}. ` +
      `Cannot bootstrap .env automatically.`,
  );
  process.exit(1);
}

const PLACEHOLDERS = [
  'replace-me-with-48-bytes-of-hex-please-replace-me',
  'replace-me-with-48-different-bytes-of-hex-please-replace',
];

let content = readFileSync(EXAMPLE_PATH, 'utf-8');
for (const placeholder of PLACEHOLDERS) {
  if (content.includes(placeholder)) {
    // INF-018: 48 bytes → 96 hex characters, well over the config's ≥32-char
    // minimum. We assert it locally so a future change to the placeholder
    // strings or the random length surfaces an error here instead of letting
    // a too-short secret slip through to runtime.
    const secret = randomBytes(48).toString('hex');
    if (secret.length < 32) {
      throw new Error('ensure-env: generated JWT secret is too short');
    }
    content = content.replace(placeholder, secret);
  }
}

// INF-013: secrets at chmod 0600 on Unix. fs.writeFileSync honours the mode
// option on POSIX; on Windows it's a no-op (ACL-based perms not bit-mode).
// Either way the file ends up owner-private. The placeholder JWT secrets in
// the .env.example are dev-only but the random ones we just substituted in
// are not — they unlock every signed token.
writeFileSync(ENV_PATH, content, { mode: 0o600 });

const banner = '─'.repeat(70);
console.info(banner);
console.info('  Created .env at the workspace root with random JWT secrets.');
console.info('');
console.info('  Defaults are tuned for no-Docker local dev (Postgres only).');
console.info(`  Edit ${path.relative(process.cwd(), ENV_PATH) || '.env'} if you need to change`);
console.info('  DATABASE_URL, enable Redis/Garage(S3)/ClamAV/LiveKit, etc.');
console.info('  See docs/native-setup.md.');
console.info(banner);
