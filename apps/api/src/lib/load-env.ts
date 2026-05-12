/**
 * Loads .env from the workspace root. Must be imported (with side effects)
 * before any module that reads `process.env` at load time, including
 * ./config.js.
 *
 *   // src/index.ts — first line:
 *   import './lib/load-env.js';
 *
 * Shared loader lives in `@tavern/shared/load-env` so api + worker stay in
 * sync. `loadedEnvPath` is exported so config-validation errors can hint
 * "did you create .env at the workspace root?" if loading was a no-op.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceEnv } from '@tavern/shared/load-env';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const loadedEnvPath: string | undefined = loadWorkspaceEnv(__dirname);
