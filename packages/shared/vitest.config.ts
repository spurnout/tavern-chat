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
      // Ratchet floor. Raised 2026-05-28 after the schema/errors/mention test
      // pass took shared to 85.6% st / 88.4% br / 92.9% fn. Floors sit just
      // under measured to absorb minor variance — they may only go up.
      thresholds: { statements: 85, branches: 87, functions: 92, lines: 85 },
    },
  },
});
