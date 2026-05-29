import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Tests are colocated in src/ (e.g. src/sync-dispatch.test.ts).
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      // federation-keys / user-keys / outbox-dispatcher are DB/queue-bound and
      // are exercised by the api integration suite (federation-keys.test.ts,
      // user-keys.test.ts, federation-outbox.test.ts), not unit tests here —
      // exclude them so this unit gate reflects the pure-logic crypto modules.
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/**/*.d.ts',
        'src/federation-keys.ts',
        'src/user-keys.ts',
        'src/outbox-dispatcher.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet floor (baseline 2026-05-28: 96.1% st / 94.3% br / 100% fn on
      // the pure-logic crypto modules: ed25519, canonical-json, at-rest,
      // ssrf-guard, message-signing). May only go up.
      thresholds: { statements: 95, branches: 92, functions: 94, lines: 95 },
    },
  },
});
