import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Plain Node env — the realtime store + the PRESENCE_UPDATE dispatch
    // path don't touch the DOM. If a future test needs jsdom, install it
    // and switch the environment locally with the `// @vitest-environment`
    // pragma.
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      all: true,
      // Web UI (components/routes) is covered by the e2e suite, not unit
      // tests. The unit-coverage gate is scoped to src/lib — the framework-
      // agnostic logic (store, gateway-client, realtime, api-client,
      // pending-invite) that IS unit-testable and worth ratcheting.
      include: ['src/lib/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet floor for src/lib (baseline 2026-05-28: 13.3% st / 58.9% br
      // / 42% fn). Raise as lib unit tests land; UI coverage lives in e2e.
      thresholds: { statements: 13, branches: 57, functions: 41, lines: 13 },
    },
  },
});
