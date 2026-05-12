#!/usr/bin/env node
/**
 * Materialize `infra/garage/garage.toml` from `garage.toml.example` on the
 * first `pnpm docker:up`. Subsequent runs are no-ops.
 *
 * In development:
 *   - If the real file is missing, copy the template and replace the three
 *     committed dev secrets with freshly generated ones.
 * In non-development (NODE_ENV=production / staging / etc.):
 *   - Require GARAGE_RPC_SECRET, GARAGE_ADMIN_TOKEN, and GARAGE_METRICS_TOKEN
 *     in the environment. Refuse to fall back to committed dev values.
 *
 * Idempotent. Safe to chain into `pnpm docker:up`. Cross-platform (pure Node).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(REPO_ROOT, 'infra', 'garage', 'garage.toml.example');
const TARGET = path.join(REPO_ROOT, 'infra', 'garage', 'garage.toml');

// The three values that ship in the .example. We pattern-match on them so
// we can swap each for a fresh secret without parsing TOML.
const DEV_RPC_SECRET = 'c483409522a12fc217f1fd0bebfb7e8dd2bee14ff87ef030695e5424aafd344e';
const DEV_ADMIN_TOKEN = 'crYKD9FI7gRwd468whjLiwH24XddADZ5NcPFthDKvTc=';
const DEV_METRICS_TOKEN = 'tuYPZE/FQq286nHWorKoSN1WU5AetqDH7BifgxHO7wY=';

if (existsSync(TARGET)) {
  // Already materialized — operator has done their thing. Nothing to do.
  process.exit(0);
}

if (!existsSync(EXAMPLE)) {
  console.error(`garage-config: template not found at ${EXAMPLE}`);
  process.exit(1);
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isDev = nodeEnv === 'development' || nodeEnv === 'test';

function generateSecrets() {
  if (isDev) {
    return {
      rpc: randomBytes(32).toString('hex'),
      admin: randomBytes(32).toString('base64'),
      metrics: randomBytes(32).toString('base64'),
    };
  }
  const missing = [];
  if (!process.env.GARAGE_RPC_SECRET) missing.push('GARAGE_RPC_SECRET');
  if (!process.env.GARAGE_ADMIN_TOKEN) missing.push('GARAGE_ADMIN_TOKEN');
  if (!process.env.GARAGE_METRICS_TOKEN) missing.push('GARAGE_METRICS_TOKEN');
  if (missing.length > 0) {
    console.error(
      `garage-config: NODE_ENV=${nodeEnv} but the following Garage secrets are unset: ${missing.join(', ')}.\n` +
        `Refusing to materialize garage.toml with the committed dev values.\n` +
        `Generate fresh secrets with:\n` +
        `  node -e "const c=require('crypto'); console.log(c.randomBytes(32).toString('hex')); console.log(c.randomBytes(32).toString('base64')); console.log(c.randomBytes(32).toString('base64'));"\n` +
        `and set them in the environment, then re-run.`,
    );
    process.exit(1);
  }
  return {
    rpc: process.env.GARAGE_RPC_SECRET,
    admin: process.env.GARAGE_ADMIN_TOKEN,
    metrics: process.env.GARAGE_METRICS_TOKEN,
  };
}

const secrets = generateSecrets();
const template = readFileSync(EXAMPLE, 'utf-8');
const materialized = template
  .replace(DEV_RPC_SECRET, secrets.rpc)
  .replace(DEV_ADMIN_TOKEN, secrets.admin)
  .replace(DEV_METRICS_TOKEN, secrets.metrics);

// INF-013: secrets at chmod 0600 on Unix. The garage.toml carries the RPC
// secret, the admin token, and the metrics token — every credential needed
// to reconfigure the cluster. On Windows the mode is ignored; ACLs from the
// user's profile still keep it private by default.
writeFileSync(TARGET, materialized, { encoding: 'utf-8', mode: 0o600 });
console.info(
  `garage-config: wrote ${path.relative(REPO_ROOT, TARGET)} (${isDev ? 'fresh dev secrets' : 'from environment'}).`,
);
