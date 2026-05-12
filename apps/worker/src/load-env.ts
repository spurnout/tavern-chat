/**
 * Loads .env from the workspace root. Must be imported (with side effects)
 * before any module that reads `process.env` at load time.
 *
 * Shared loader lives in `@tavern/shared/load-env` so api + worker stay in
 * sync.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceEnv } from '@tavern/shared/load-env';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const loadedEnvPath: string | undefined = loadWorkspaceEnv(__dirname);
