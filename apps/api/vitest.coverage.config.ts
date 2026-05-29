import { defineConfig } from 'vitest/config';

/**
 * Merged coverage across the unit (test/) and integration (test-integration/)
 * suites. The integration suite runs the API in-process via `app.inject`, so
 * v8 attributes route / gateway / service execution to the api source —
 * combining both runs is the only way to see api's REAL coverage (routes are
 * integration-covered; services/lib are split across both).
 *
 * Requires Docker (testcontainers) for the integration project; without it
 * those tests skip and the report under-counts, so this config is the CI /
 * Docker-up gate. The plain `test` and `test:integration` scripts keep using
 * the single-purpose configs for fast, isolated local runs.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          globals: false,
          include: ['test/**/*.test.ts'],
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          globals: false,
          include: ['test-integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
