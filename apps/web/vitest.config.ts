import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    // Two projects: framework-agnostic logic runs in plain Node (fast, no DOM);
    // component / a11y tests run in jsdom with Testing Library + jest-axe.
    // Split by extension+path so the existing lib suite is untouched.
    projects: [
      {
        test: {
          name: 'node',
          // The realtime store + PRESENCE_UPDATE dispatch path don't touch the
          // DOM. Keep this suite DOM-free and fast.
          environment: 'node',
          globals: false,
          include: ['src/lib/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      all: true,
      // Web UI (components/routes) behavior is covered by the dom project +
      // e2e suite; the ratcheted unit-coverage gate stays scoped to src/lib —
      // the framework-agnostic logic (store, gateway-client, realtime,
      // api-client, pending-invite) that's worth a hard floor.
      include: ['src/lib/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // Ratchet floor for src/lib (baseline 2026-05-28: 13.3% st / 58.9% br
      // / 42% fn). Raise as lib unit tests land; UI coverage lives in the dom
      // project + e2e.
      thresholds: { statements: 13, branches: 57, functions: 41, lines: 13 },
    },
  },
});
