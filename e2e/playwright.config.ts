import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Playwright config for Tavern's E2E suites.
 *
 * Two projects:
 *   chromium     — fast smoke tests (golden-path.spec.ts).
 *   walkthrough  — runs walkthrough.spec.ts at a relaxed pace and always
 *                  records video. Output lands under
 *                  `test-results/<test>-walkthrough/video.webm`.
 *
 * Both projects assume a running dev stack (`pnpm docker:up && pnpm dev`).
 * The walkthrough additionally needs the seed: `pnpm db:seed`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 5 * 60_000,
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
      testIgnore: /walkthrough\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'walkthrough',
      testMatch: /walkthrough\.spec\.ts$/,
      timeout: 5 * 60_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        video: { mode: 'on', size: { width: 1280, height: 800 } },
      },
    },
  ],
});
