import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres via testcontainers.
 * They live under test-integration/ and run via `pnpm test:integration`.
 *
 * Skipped automatically if Docker isn't available — the suite checks for
 * a running daemon in its global setup and skips with a clear message.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
