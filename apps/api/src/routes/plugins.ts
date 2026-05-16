import type { FastifyInstance } from 'fastify';
import { TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { listLoadedPlugins, pluginsLoaded } from '../services/plugin-loader.js';

/**
 * Wave 3 #47 — admin-facing plugin listing.
 *
 * V1 surface: read-only. Operators install plugins by dropping a directory
 * into the plugins folder and restarting; per-server install + runtime
 * uninstall is documented as a follow-up (would need the `InstalledPlugin`
 * model + a per-server permission-gated dispatch).
 */
export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/plugins', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    // Instance-admin gate. Listing plugins exposes operator-controlled
    // surface area; non-admins don't need to see what's loaded.
    if (!ctx.isInstanceAdmin) {
      throw TavernError.forbidden('Instance admins only');
    }
    reply.send(
      ok({
        count: pluginsLoaded(),
        plugins: listLoadedPlugins(),
      }),
    );
  });
}
