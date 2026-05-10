/**
 * Load environment variables from a .env file at the workspace root.
 *
 * Must be imported (with side effects) before any module that reads
 * `process.env` at load time, including ./config.js. The convention is:
 *
 *   // src/index.ts — first line:
 *   import './lib/load-env.js';
 *
 * Behaviour:
 *   - Walks up from this file's location until it finds a `.env`.
 *   - If found, calls dotenv.config({ path }). Existing process.env values
 *     win, so docker/systemd/CI-supplied env still wins over .env.
 *   - If no .env is found, does nothing (silent). Production deployments
 *     that pre-set env vars work without a file present.
 *
 * The helper exports `loadedEnvPath` so config-validation errors can hint
 * "did you create .env at the workspace root?" if loading was a no-op.
 */

import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findWorkspaceEnv(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const found = findWorkspaceEnv();
if (found) {
  dotenv.config({ path: found });
}

export const loadedEnvPath: string | undefined = found;
