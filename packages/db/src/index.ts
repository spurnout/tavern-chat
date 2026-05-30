import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  __tavern_prisma__?: PrismaClient;
};

/**
 * Returns the current globalThis.__tavern_prisma__ client, creating and
 * caching a default one if none exists yet.
 *
 * Callers that run BEFORE process.env.DATABASE_URL is set (e.g. module-level
 * imports) are safe: Prisma reads the env lazily at query time.  However, in
 * the integration-test harness startPostgres() replaces globalThis.__tavern_prisma__
 * with a client that has an explicit datasource URL — this function always
 * returns the most-current slot so those callers transparently switch over.
 */
function _getOrCreate(): PrismaClient {
  if (!globalForPrisma.__tavern_prisma__) {
    globalForPrisma.__tavern_prisma__ = new PrismaClient({
      log:
        process.env.NODE_ENV === 'production'
          ? ['error', 'warn']
          : ['warn', 'error'],
    });
  }
  return globalForPrisma.__tavern_prisma__;
}

/**
 * A single shared PrismaClient. In dev/test the workspace is reloaded often,
 * so we cache the instance on globalThis to avoid exhausting the DB connection
 * pool. The exported value is a live Proxy: every property access re-reads the
 * globalThis slot so that if the test harness replaces the slot with a
 * testcontainer-backed client (which has an explicit URL), all callers —
 * including those that captured the import reference before the swap — will
 * automatically use the replacement.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const live = _getOrCreate();
    const val = Reflect.get(live, prop, live);
    // Bind methods so that `this` inside PrismaClient internals refers to the
    // real client, not the Proxy wrapper.
    return typeof val === 'function'
      ? (val as (...args: unknown[]) => unknown).bind(live)
      : val;
  },
  set(_target, prop, value) {
    return Reflect.set(_getOrCreate(), prop, value);
  },
  has(_target, prop) {
    return Reflect.has(_getOrCreate(), prop);
  },
});

export async function disconnectPrisma(): Promise<void> {
  await _getOrCreate().$disconnect();
}

// Federation #23 — Server.iconUrl maintenance (resolve local icons via the
// storage backend; backfill on scan-complete). Exported here so both the api
// and the BullMQ worker can reach it.
export {
  resolveServerIconUrl,
  refreshServerIconsForAttachment,
  type IconUrlResolver,
} from './server-icon.js';
