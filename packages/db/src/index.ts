import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  __tavern_prisma__?: PrismaClient;
};

/**
 * A single shared PrismaClient. In dev the workspace is reloaded a lot, so we
 * cache the client on globalThis to avoid exhausting the DB connection pool.
 */
export const prisma: PrismaClient =
  globalForPrisma.__tavern_prisma__ ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__tavern_prisma__ = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
