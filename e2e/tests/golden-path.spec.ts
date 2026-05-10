import { test, expect } from '@playwright/test';

/**
 * Golden path smoke test:
 *   1. Land on /, redirected to /login.
 *   2. Sign in as the seeded admin.
 *   3. Land on the seeded server's first channel.
 *   4. Send a message; see it render.
 *   5. Send a /roll 1d20 dice command; see a dice-roll bubble.
 *
 * The test uses the dev seed defaults (admin@example.com / change-me-in-dev).
 * Run with the dev stack already up (`pnpm docker:up && pnpm dev`).
 */

test.describe('Tavern golden path', () => {
  test('login, send message, roll dice', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Username or email').fill('admin');
    await page.getByLabel('Password').fill('change-me-in-dev');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Land in the app — the seeded server has a #lobby channel.
    await expect(page).toHaveURL(/\/app/);
    await page.getByRole('link', { name: /lobby/i }).click();

    // Send a message.
    const composer = page.getByPlaceholder(/^Message/);
    const stamp = Date.now();
    const text = `e2e ${stamp}`;
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.getByText(text)).toBeVisible();

    // Roll dice.
    await composer.fill('/roll 1d20');
    await composer.press('Enter');
    await expect(page.getByText(/1d20/).first()).toBeVisible();
  });
});
