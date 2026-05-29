import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet floor (baseline 2026-05-28: 38.1% st / 77.8% br / 60% fn).
      // Raise these as Phase 2 tests land — they may only go up.
      thresholds: { statements: 37, branches: 76, functions: 58, lines: 37 },
    },
  },
});
