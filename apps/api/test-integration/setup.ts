/**
 * Spin up a Postgres testcontainer per test file, apply the Prisma schema,
 * and expose a fresh PrismaClient bound to that ephemeral DB.
 *
 * We do `prisma db push` (not migrate deploy) for speed — integration tests
 * don't care about migration history, only the resulting schema.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../../packages/db/prisma/schema.prisma');

export interface IntegrationContext {
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  databaseUrl: string;
}

export async function startPostgres(): Promise<IntegrationContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tavern_test')
    .withUsername('tavern_test')
    .withPassword('tavern_test')
    .start();

  const databaseUrl = container.getConnectionUri();

  execSync(`pnpm --silent prisma db push --schema "${SCHEMA_PATH}" --skip-generate`, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();

  return { container, prisma, databaseUrl };
}

export async function stopPostgres(ctx: IntegrationContext): Promise<void> {
  await ctx.prisma.$disconnect().catch(() => undefined);
  await ctx.container.stop();
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
