#!/usr/bin/env node
/**
 * One-time bootstrap for the local Garage container.
 *
 * Run after `pnpm docker:up` (or the LiveKit-profile variant) when the
 * tavern-garage container is healthy. Idempotent — re-runs are no-ops.
 *
 *   pnpm garage:bootstrap
 *
 * Steps:
 *   1. Wait for garage to respond to `garage status`
 *   2. Assign + apply layout for the single node (zone dc1, 1 GB)
 *   3. Import a key with S3_ACCESS_KEY / S3_SECRET_KEY from .env so Tavern's
 *      existing credentials work as-is
 *   4. Create the media + quarantine buckets
 *   5. Grant the dev key read/write on both
 *   6. Best-effort: enable anonymous public reads on the media bucket
 *
 * Cross-platform — pure Node, no shell dependency.
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const CONTAINER = 'tavern-garage';

const DEFAULTS = {
  // Garage requires access-key IDs to be at least 8 chars; "tavernkey" is 9.
  S3_ACCESS_KEY: 'tavernkey',
  S3_SECRET_KEY: 'tavern-dev-secret',
  S3_BUCKET: 'tavern-media',
  S3_QUARANTINE_BUCKET: 'tavern-quarantine',
};

function loadEnv() {
  const out = { ...DEFAULTS };
  if (!existsSync(ENV_PATH)) return out;
  const text = readFileSync(ENV_PATH, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k in out && v) out[k] = v;
  }
  return out;
}

function assertDevOnly(env) {
  const usingDefaultSecret = env.S3_SECRET_KEY === DEFAULTS.S3_SECRET_KEY;
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (usingDefaultSecret && !['development', 'test'].includes(nodeEnv)) {
    console.error(
      `garage-bootstrap: refusing to use the built-in dev secret with NODE_ENV=${nodeEnv}.\n` +
        `Set S3_ACCESS_KEY and S3_SECRET_KEY in .env (or unset NODE_ENV) before re-running.`,
    );
    process.exit(1);
  }
  if (usingDefaultSecret) {
    console.warn(
      'garage-bootstrap: WARN — using built-in dev S3 credentials. Override S3_ACCESS_KEY / S3_SECRET_KEY in .env for anything other than local dev.',
    );
  }
}

// Defence-in-depth: these values become positional CLI arguments to
// `docker exec ... /garage`. Garage itself enforces sane shapes today, but
// a value containing a leading `-` would be interpreted as a flag, and a
// newline could split the command. Restrict to the alphabet operators
// realistically use for these fields.
function assertSafeArgValues(env) {
  const SHAPE = /^[A-Za-z0-9._-]+$/;
  const checks = [
    ['S3_ACCESS_KEY', env.S3_ACCESS_KEY],
    ['S3_SECRET_KEY', env.S3_SECRET_KEY],
    ['S3_BUCKET', env.S3_BUCKET],
    ['S3_QUARANTINE_BUCKET', env.S3_QUARANTINE_BUCKET],
  ];
  for (const [name, value] of checks) {
    if (typeof value !== 'string' || !SHAPE.test(value)) {
      console.error(
        `garage-bootstrap: ${name} must match /^[A-Za-z0-9._-]+$/ to be safe as a CLI argument (got: ${JSON.stringify(value)}).`,
      );
      process.exit(1);
    }
  }
}

function garage(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', ['exec', CONTAINER, '/garage', ...args], {
    encoding: 'utf-8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !allowFail) {
    console.error(`garage ${args.join(' ')} failed (exit ${r.status}):\n${out}`);
    process.exit(1);
  }
  return { ok: r.status === 0, output: out.trim() };
}

function dockerRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function containerHealthy() {
  try {
    const out = execSync(
      `docker inspect ${CONTAINER} --format "{{.State.Health.Status}}"`,
      { encoding: 'utf-8' },
    ).trim();
    return out === 'healthy';
  } catch {
    return false;
  }
}

if (!dockerRunning()) {
  console.error('Docker daemon not reachable. Start Docker Desktop and retry.');
  process.exit(1);
}

// INF-019: configurable health-wait. Cold-storage hosts (slow disks,
// over-provisioned mount points) sometimes take longer than 60s to assign
// the initial layout. Operators can bump this with `GARAGE_HEALTH_TIMEOUT_MS`
// when they need to.
const rawTimeoutMs = Number(process.env.GARAGE_HEALTH_TIMEOUT_MS ?? 60_000);
const healthTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 60_000;
if (process.env.GARAGE_HEALTH_TIMEOUT_MS && !Number.isFinite(rawTimeoutMs)) {
  console.warn(
    `garage-bootstrap: GARAGE_HEALTH_TIMEOUT_MS=${process.env.GARAGE_HEALTH_TIMEOUT_MS} is not a number, falling back to 60000ms.`,
  );
}
console.info(`garage-bootstrap: waiting for tavern-garage to be healthy (${healthTimeoutMs}ms)...`);
const deadline = Date.now() + healthTimeoutMs;
while (!containerHealthy()) {
  if (Date.now() > deadline) {
    console.error(
      'garage-bootstrap: tavern-garage never reached healthy. Run `pnpm docker:up` and check `docker logs tavern-garage`.',
    );
    process.exit(1);
  }
  await sleep(2_000);
}
console.info('garage-bootstrap: garage healthy');

// 1. Pull node id.
const nodeIdOut = garage(['node', 'id', '-q']).output.split('\n')[0];
const NODE_ID = nodeIdOut.split('@')[0];
if (!NODE_ID) {
  console.error(`garage-bootstrap: could not read node id from "${nodeIdOut}"`);
  process.exit(1);
}
console.info(`garage-bootstrap: node id ${NODE_ID}`);

// 2. Layout. Assign this node a role, then apply whichever version Garage
//   actually staged — `layout show` prints the exact `apply --version N`.
//   Hard-coding `--version 1` silently failed whenever a re-run or a prior
//   partial apply bumped the pending version past 1, leaving the layout
//   unapplied and buckets later failing with "Layout not ready". On a settled
//   cluster `layout show` stages nothing and we skip the apply.
garage(['layout', 'assign', '-z', 'dc1', '-c', '1G', NODE_ID], { allowFail: true });
const layoutShow = garage(['layout', 'show'], { allowFail: true }).output;
const stagedVersion = layoutShow.match(/apply --version (\d+)/)?.[1];
if (stagedVersion) {
  const layoutApply = garage(['layout', 'apply', '--version', stagedVersion], { allowFail: true });
  console.info(
    layoutApply.ok
      ? `garage-bootstrap: applied layout version ${stagedVersion}`
      : 'garage-bootstrap: layout apply did not run (already bootstrapped, or version raced). Continuing.',
  );
} else {
  console.info('garage-bootstrap: layout already applied (nothing staged). Continuing.');
}

const env = loadEnv();
assertDevOnly(env);
assertSafeArgValues(env);
console.info(`garage-bootstrap: importing key id="${env.S3_ACCESS_KEY}"`);

// 3. Import key with known credentials.
// `garage key import` v2.3 syntax: positional <key-id> <secret-key>, --yes
// to skip the confirmation prompt, -n to set the key's human-readable name.
garage(
  [
    'key',
    'import',
    '--yes',
    '-n',
    'tavern-key',
    env.S3_ACCESS_KEY,
    env.S3_SECRET_KEY,
  ],
  { allowFail: true },
);

// 4. Buckets.
for (const b of [env.S3_BUCKET, env.S3_QUARANTINE_BUCKET]) {
  console.info(`garage-bootstrap: bucket ${b}`);
  garage(['bucket', 'create', b], { allowFail: true });
  garage(['bucket', 'allow', '--read', '--write', '--owner', b, '--key', 'tavern-key']);
}

// 5. Anonymous public reads on the media bucket. Two attempts (different
// Garage versions accept different syntaxes); if both fail we warn but
// continue — uploads work, only direct browser fetches break.
const anonAttempts = [
  ['bucket', 'allow', '--read', env.S3_BUCKET],
  ['bucket', 'website', '--allow', env.S3_BUCKET],
];
let anonOk = false;
for (const args of anonAttempts) {
  const r = garage(args, { allowFail: true });
  if (r.ok) {
    anonOk = true;
    console.info(`garage-bootstrap: anonymous read enabled (${args.join(' ')})`);
    break;
  }
}
if (!anonOk) {
  console.warn(
    'garage-bootstrap: WARN — could not enable anonymous reads automatically.',
  );
  console.warn(
    '  Tavern will still upload/scan attachments, but the frontend will get 403 on direct S3 GETs.',
  );
  console.warn(
    '  See docs/docker-setup.md for the manual fix.',
  );
}

// 6. Best-effort: apply CORS so cross-origin browser PUTs work. Required
// whenever the web app and S3 endpoint are on different origins (always the
// case in prod with a separate garage.* subdomain). Harmless to apply in dev
// even when STORAGE_BACKEND=local — operators flipping to s3 mid-session
// then don't have to remember a second command. Non-fatal on failure; the
// operator can rerun `pnpm garage:cors` directly with more diagnostics.
const corsResult = spawnSync(
  process.execPath,
  [path.join(__dirname, 'garage-cors.mjs')],
  { encoding: 'utf-8' },
);
if (corsResult.status !== 0) {
  console.warn('garage-bootstrap: WARN — CORS apply failed (non-fatal). Re-run `pnpm garage:cors` for details.');
  if (corsResult.stdout) console.warn(corsResult.stdout.trim());
  if (corsResult.stderr) console.warn(corsResult.stderr.trim());
} else {
  console.info(corsResult.stdout.trim());
}

console.info('garage-bootstrap: done.');
