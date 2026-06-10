#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const PNPM = 'pnpm';
const WEB_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3030'}`;
const API_URL = process.env.API_HEALTH_URL ?? `http://localhost:${process.env.PORT ?? '3001'}/healthz`;
const STARTUP_TIMEOUT_MS = Number(process.env.FULL_PROOF_STARTUP_TIMEOUT_MS ?? 120_000);

let devProcess;

try {
  await run(PNPM, ['ensure-env']);
  if (!(await dockerAvailable())) {
    console.info(
      [
        '[full-local-proof] SKIPPED: Docker is not available or the daemon is not running.',
        '[full-local-proof] Start Docker Desktop, then rerun `pnpm proof:local` for integration + E2E proof.',
        '[full-local-proof] The normal `pnpm test:integration` no-Docker skip behavior is unchanged.',
      ].join('\n'),
    );
    process.exit(0);
  }

  await run(PNPM, ['docker:up:all']);
  await run(PNPM, ['db:migrate']);
  await run(PNPM, ['db:seed']);
  await run(PNPM, ['test:integration']);

  devProcess = spawnDev();
  await Promise.all([waitFor(API_URL), waitFor(WEB_URL)]);
  await run(PNPM, ['test:e2e'], {
    env: { ...process.env, E2E_BASE_URL: WEB_URL },
  });
} finally {
  if (devProcess) await stopProcessTree(devProcess);
}

async function dockerAvailable() {
  const result = await run('docker', ['info'], {
    allowFailure: true,
    stdio: 'ignore',
  });
  return result === 0;
}

function spawnDev() {
  console.info(`[full-local-proof] Starting dev stack for E2E (${WEB_URL})`);
  const child = spawn(PNPM, ['dev'], {
    cwd: ROOT,
    detached: !IS_WINDOWS,
    env: process.env,
    stdio: 'inherit',
    shell: IS_WINDOWS,
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    if (code !== null) console.info(`[full-local-proof] dev stack exited with code ${code}`);
    if (signal) console.info(`[full-local-proof] dev stack exited on ${signal}`);
  });
  return child;
}

async function waitFor(url) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        console.info(`[full-local-proof] Ready: ${url}`);
        return;
      }
      lastError = new Error(`${url} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await delay(1_000);
  }
  throw new Error(
    `[full-local-proof] Timed out waiting for ${url}: ${lastError?.message ?? 'unknown error'}`,
  );
}

function run(command, args, opts = {}) {
  const stdio = opts.stdio ?? 'inherit';
  const spawnCommand = IS_WINDOWS ? commandForWindowsShell(command, args) : command;
  const spawnArgs = IS_WINDOWS ? [] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: ROOT,
      env: opts.env ?? process.env,
      stdio,
      shell: IS_WINDOWS,
      windowsHide: stdio !== 'inherit',
    });
    child.on('error', (err) => {
      if (opts.allowFailure) resolve(1);
      else reject(err);
    });
    child.on('exit', (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0 || opts.allowFailure) resolve(exitCode);
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}`));
    });
  });
}

async function stopProcessTree(child) {
  if (!child.pid) return;
  console.info('[full-local-proof] Stopping dev stack');
  if (IS_WINDOWS) {
    await run('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      allowFailure: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  await delay(3_000);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

function commandForWindowsShell(command, args) {
  return [command, ...args.map(quoteWindowsArg)].join(' ');
}

function quoteWindowsArg(arg) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
