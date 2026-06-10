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
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      all: true,
      // Integration tests run the API in-process (app.inject), so v8 captures
      // route + gateway + service execution. Report-only for now; a ratchet
      // threshold will be set from a clean full-suite CI run (the suite is
      // resource-starved when the full local Docker stack is also up).
      include: ['src/routes/**/*.ts', 'src/gateway/**/*.ts', 'src/services/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage-integration',
    },
  },
});
