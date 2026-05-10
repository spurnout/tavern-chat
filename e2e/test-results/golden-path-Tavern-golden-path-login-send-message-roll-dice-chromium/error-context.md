# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: golden-path.spec.ts >> Tavern golden path >> login, send message, roll dice
- Location: tests\golden-path.spec.ts:16:3

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/
Call log:
  - navigating to "http://localhost:3000/", waiting until "load"

```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | /**
  4  |  * Golden path smoke test:
  5  |  *   1. Land on /, redirected to /login.
  6  |  *   2. Sign in as the seeded admin.
  7  |  *   3. Land on the seeded server's first channel.
  8  |  *   4. Send a message; see it render.
  9  |  *   5. Send a /roll 1d20 dice command; see a dice-roll bubble.
  10 |  *
  11 |  * The test uses the dev seed defaults (admin@example.com / change-me-in-dev).
  12 |  * Run with the dev stack already up (`pnpm docker:up && pnpm dev`).
  13 |  */
  14 | 
  15 | test.describe('Tavern golden path', () => {
  16 |   test('login, send message, roll dice', async ({ page }) => {
> 17 |     await page.goto('/');
     |                ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/
  18 |     await expect(page).toHaveURL(/\/login$/);
  19 | 
  20 |     await page.getByLabel('Username or email').fill('admin');
  21 |     await page.getByLabel('Password').fill('change-me-in-dev');
  22 |     await page.getByRole('button', { name: /sign in/i }).click();
  23 | 
  24 |     // Land in the app — the seeded server has a #lobby channel.
  25 |     await expect(page).toHaveURL(/\/app/);
  26 |     await page.getByRole('link', { name: /lobby/i }).click();
  27 | 
  28 |     // Send a message.
  29 |     const composer = page.getByPlaceholder(/^Message/);
  30 |     const stamp = Date.now();
  31 |     const text = `e2e ${stamp}`;
  32 |     await composer.fill(text);
  33 |     await composer.press('Enter');
  34 |     await expect(page.getByText(text)).toBeVisible();
  35 | 
  36 |     // Roll dice.
  37 |     await composer.fill('/roll 1d20');
  38 |     await composer.press('Enter');
  39 |     await expect(page.getByText(/1d20/).first()).toBeVisible();
  40 |   });
  41 | });
  42 | 
```