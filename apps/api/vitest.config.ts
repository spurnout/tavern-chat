import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      all: true,
      // Unit gate scoped to the logic unit tests target. Routes + the gateway
      // are exercised by the integration suite (app.inject, in-process), which
      // reports its own coverage (see vitest.integration.config.ts).
      include: ['src/services/**/*.ts', 'src/lib/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet floor for services+lib via UNIT tests (baseline 2026-05-28:
      // 12.6% st / 72.8% br / 17% fn). Routes/gateway coverage is reported by
      // the integration suite. Raise as Phase 2 unit tests land.
      thresholds: { statements: 12, branches: 71, functions: 16, lines: 12 },
    },
  },
});
