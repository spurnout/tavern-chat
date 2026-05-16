#!/usr/bin/env node
/**
 * Run a command with the workspace-root `.env` loaded into its environment.
 *
 * Tools that read env vars directly (Prisma CLI, ad-hoc scripts) don't see
 * the `.env` at the repo root because they run with their cwd set to a
 * subpackage. This wrapper bridges that — load `.env`, exec the command,
 * forward stdio + the exit code.
 *
 * Usage:
 *   node scripts/with-env.mjs <command> [args...]
 *
 * Existing process.env values win over `.env` (so an operator can override
 * a single var inline without editing the file).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if symmetric.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

if (existsSync(ENV_PATH)) {
  const parsed = parseEnv(readFileSync(ENV_PATH, 'utf-8'));
  for (const [k, v] of Object.entries(parsed)) {
    // Don't clobber an explicit override the caller set in the shell.
    if (!(k in process.env)) process.env[k] = v;
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('with-env: missing command. Usage: node scripts/with-env.mjs <cmd> [args...]');
  process.exit(2);
}

// `shell: true` so pnpm/npx/etc resolve via the OS's PATH lookup the same
// way an interactive shell would — needed on Windows where pnpm lives in
// a .cmd wrapper.
const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error(`with-env: failed to spawn ${cmd}: ${err.message}`);
  process.exit(1);
});
