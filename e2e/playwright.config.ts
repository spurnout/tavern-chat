import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Playwright config for Tavern's golden-path smoke tests.
 *
 * The tests assume a running stack: docker compose up + api + web + worker.
 * They use the dev seed (DEV-INVITE / admin user). For CI, a `start-stack.sh`
 * helper is the obvious extension; we keep this config lean so contributors
 * can run it against their already-running dev stack.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['line']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
