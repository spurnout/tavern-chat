/**
 * Per-fork shared Postgres container.
 *
 * Vitest's pool is configured with `singleFork: true`, so every test file in
 * the integration suite runs in the same Node worker. We boot one container
 * (and apply the schema once) on the first `startPostgres()` call from any
 * test file, and reuse it for the rest. The container is stopped from
 * `globalTeardown` so the run cleans up after itself.
 *
 * The critical bit: the singleton lives in this module, which is imported
 * BEFORE `@tavern/db`'s prisma singleton is created (because the import
 * graph is test → setup → service → @tavern/db). Setting DATABASE_URL in
 * the first `startPostgres()` guarantees the prisma singleton reads the
 * containerized URL.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../../packages/db/prisma/schema.prisma');

export interface IntegrationContext {
  container: StartedPostgreSqlContainer | null;
  prisma: PrismaClient;
  databaseUrl: string;
}

// Hoist the shared container AND the shared data key onto globalThis so
// Vitest's per-file module reloads don't drop the cache. Vitest in
// `singleFork: true` still gives each test file its own ES-module graph,
// which means a plain module-level `let` / `const` gets re-initialised
// between files — that's why an earlier implementation silently started a
// NEW Postgres container per file and the @tavern/db singleton ended up
// pointing at a different container than ctx.prisma.
//
// The same issue affects SHARED_DATA_KEY: FederationKeyStore.bootstrap()
// persists the encrypted instance keypair to the shared testcontainer DB on
// the FIRST buildApp() call; a different key on any subsequent buildApp()
// call causes AES-GCM to throw "Unsupported state or unable to authenticate
// data". Storing the key on globalThis ensures every test file reads the
// same 32 bytes.
interface GlobalSlot {
  __tavern_integration_ctx__?: IntegrationContext;
  __tavern_integration_docker_probe__?: boolean;
  __tavern_integration_data_key__?: string;
}
const globalSlot = globalThis as unknown as GlobalSlot;

/**
 * Single AES-GCM data key shared across the entire integration test run.
 * Generated lazily on the first import and hoisted to globalThis so it
 * survives Vitest's per-file ES-module graph re-initialisation.
 *
 * IMPORTANT: every buildApp() call in integration tests MUST use this key.
 */
export const SHARED_DATA_KEY: string = (() => {
  if (!globalSlot.__tavern_integration_data_key__) {
    globalSlot.__tavern_integration_data_key__ = randomBytes(32).toString('base64');
  }
  return globalSlot.__tavern_integration_data_key__;
})();

export async function startPostgres(): Promise<IntegrationContext> {
  if (globalSlot.__tavern_integration_ctx__) return globalSlot.__tavern_integration_ctx__;
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tavern_test')
    .withUsername('tavern_test')
    .withPassword('tavern_test')
    .start();
  const databaseUrl = container.getConnectionUri();
  // Update DATABASE_URL so that any new PrismaClient() created AFTER this
  // point (via dynamic imports or fresh module evaluation) uses the
  // testcontainer URL.
  process.env['DATABASE_URL'] = databaseUrl;
  // Prisma lives in @tavern/db, not @tavern/api, so we have to invoke it
  // through that workspace — bare `pnpm exec prisma` from here fails with
  // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL "Command 'prisma' not found", which
  // earlier was being swallowed by `--silent` + `stdio: 'pipe'` and turned
  // into an empty Buffer(0) error object in CI logs. stdio: 'inherit' keeps
  // the next failure (if any) directly visible.
  execSync(
    `pnpm --filter @tavern/db exec prisma db push --schema "${SCHEMA_PATH}" --skip-generate`,
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  // Redirect the @tavern/db global Prisma singleton to the testcontainer so
  // that service functions which import `prisma` directly from @tavern/db
  // (e.g. findPeersWithRemoteMembers, fanOutMessageCreate) query the same DB
  // as ctx.prisma.
  //
  // Why this is needed: @tavern/db caches the PrismaClient on
  // globalThis.__tavern_prisma__ (to survive hot-reloads). Static imports at
  // test-file top level cause @tavern/db to be evaluated BEFORE startPostgres()
  // runs, so the cached client was created with the pre-testcontainer
  // DATABASE_URL. Replacing the slot here ensures every subsequent test file's
  // fresh module evaluation of @tavern/db picks up the testcontainer client via
  // the globalThis cache.
  (globalThis as Record<string, unknown>)['__tavern_prisma__'] = prisma;
  globalSlot.__tavern_integration_ctx__ = { container, prisma, databaseUrl };
  return globalSlot.__tavern_integration_ctx__;
}

/**
 * Start a SECOND, independent Postgres container for two-instance isolation
 * tests. Unlike `startPostgres()` this function:
 *  - Does NOT touch `globalThis.__tavern_integration_ctx__`
 *  - Does NOT overwrite `process.env['DATABASE_URL']`
 *  - Does NOT overwrite `globalThis.__tavern_prisma__`
 *  - Is NOT cached — each call starts a fresh container
 *
 * Callers are responsible for stopping the returned container via
 * `stopPostgres(ctx)` in their `afterAll`.
 */
export async function startSecondPostgres(): Promise<IntegrationContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tavern_test2')
    .withUsername('tavern_test2')
    .withPassword('tavern_test2')
    .start();
  const databaseUrl = container.getConnectionUri();
  execSync(
    `pnpm --filter @tavern/db exec prisma db push --schema "${SCHEMA_PATH}" --skip-generate`,
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    },
  );
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  return { container, prisma, databaseUrl };
}

export async function stopPostgres(ctx: IntegrationContext): Promise<void> {
  // The PRIMARY container (globalSlot.__tavern_integration_ctx__) is shared
  // across all test files in the singleFork run and must NOT be stopped by
  // individual test files — it's owned by the process lifetime.
  //
  // SECONDARY containers created by startSecondPostgres() are NOT registered
  // in the global slot, so we stop them here when the caller requests it.
  if (ctx === globalSlot.__tavern_integration_ctx__) return;
  if (!ctx.container) return;
  await ctx.prisma.$disconnect().catch(() => undefined);
  await ctx.container.stop().catch(() => undefined);
}

export async function isDockerAvailable(): Promise<boolean> {
  if (globalSlot.__tavern_integration_docker_probe__ !== undefined) {
    return globalSlot.__tavern_integration_docker_probe__;
  }
  try {
    execSync('docker info', { stdio: 'pipe' });
    globalSlot.__tavern_integration_docker_probe__ = true;
  } catch {
    globalSlot.__tavern_integration_docker_probe__ = false;
  }
  return globalSlot.__tavern_integration_docker_probe__;
}

/**
 * Truncate every application table (CASCADE) for a guaranteed clean slate,
 * independent of cross-file execution order. The integration suite shares one
 * Postgres testcontainer (singleFork) and Vitest's file order is NOT stable
 * (it sorts by cached timings), so a preceding file can leave rows that block
 * another file's targeted deletes — e.g. a leftover Server whose ownerUserId
 * restricts `user.deleteMany`, throwing P2003. Calling resetDb() in a
 * beforeEach sidesteps every such ordering hazard.
 *
 * Table names come from pg_tables (not user input), so the dynamic TRUNCATE is
 * safe. _prisma_migrations is preserved so the pushed schema stays intact.
 */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const quoted = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
