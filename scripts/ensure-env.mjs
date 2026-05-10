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
    content = content.replace(placeholder, randomBytes(48).toString('hex'));
  }
}

writeFileSync(ENV_PATH, content);

const banner = '─'.repeat(70);
console.info(banner);
console.info('  Created .env at the workspace root with random JWT secrets.');
console.info('');
console.info('  Defaults are tuned for no-Docker local dev (Postgres only).');
console.info(`  Edit ${path.relative(process.cwd(), ENV_PATH) || '.env'} if you need to change`);
console.info('  DATABASE_URL, enable Redis/MinIO/ClamAV/LiveKit, etc.');
console.info('  See docs/native-setup.md.');
console.info(banner);
