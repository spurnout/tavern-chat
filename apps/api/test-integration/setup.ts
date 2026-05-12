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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../../packages/db/prisma/schema.prisma');

export interface IntegrationContext {
  container: StartedPostgreSqlContainer | null;
  prisma: PrismaClient;
  databaseUrl: string;
}

// Hoist the shared container onto globalThis so Vitest's per-file module
// reloads don't drop the cache. Vitest in `singleFork: true` still gives each
// test file its own ES-module graph, which means a plain module-level `let`
// gets re-initialised between files — that's why an earlier implementation
// silently started a NEW Postgres container per file and the @tavern/db
// singleton ended up pointing at a different container than ctx.prisma.
interface GlobalSlot {
  __tavern_integration_ctx__?: IntegrationContext;
  __tavern_integration_docker_probe__?: boolean;
}
const globalSlot = globalThis as unknown as GlobalSlot;

export async function startPostgres(): Promise<IntegrationContext> {
  if (globalSlot.__tavern_integration_ctx__) return globalSlot.__tavern_integration_ctx__;
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tavern_test')
    .withUsername('tavern_test')
    .withPassword('tavern_test')
    .start();
  const databaseUrl = container.getConnectionUri();
  // Critical ordering: set DATABASE_URL BEFORE Prisma's singleton is touched.
  process.env['DATABASE_URL'] = databaseUrl;
  execSync(`pnpm --silent prisma db push --schema "${SCHEMA_PATH}" --skip-generate`, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  globalSlot.__tavern_integration_ctx__ = { container, prisma, databaseUrl };
  return globalSlot.__tavern_integration_ctx__;
}

export async function stopPostgres(_ctx: IntegrationContext): Promise<void> {
  // Owned by the global teardown — no-op so concurrent files don't stop the
  // container out from under each other. The teardown export below is what
  // Vitest calls once at the end of the run.
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
