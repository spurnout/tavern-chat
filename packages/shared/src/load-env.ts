/**
 * Workspace-root .env loader, shared between api and worker.
 *
 * Not re-exported from `@tavern/shared`'s main entry — the web bundle must
 * not pull in `dotenv` and the Node-only filesystem APIs used here. Import
 * via the explicit sub-path:
 *
 *   import { loadWorkspaceEnv } from '@tavern/shared/load-env';
 *
 * Behaviour:
 *   - Walks up from `startDir` for up to 10 levels looking for a `.env`.
 *   - If found, calls dotenv.config({ path }). Existing process.env values
 *     win, so docker/systemd/CI-supplied env still wins over .env.
 *   - If no .env is found, returns undefined silently. Production deployments
 *     that pre-set env vars work without a file present.
 */

import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function loadWorkspaceEnv(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
