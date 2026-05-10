/**
 * Load environment variables from a .env file at the workspace root.
 * See apps/api/src/lib/load-env.ts for the rationale — this is the worker's
 * copy. Imported with side effects before anything else.
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
