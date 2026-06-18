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
 * Run with `pnpm dev` (Postgres required; Docker only needed for the
 * optional services like Redis/Garage/ClamAV).
 */

test.describe('Tavern golden path', () => {
  test('login, send message, roll dice', async ({ page }) => {
    await signIn(page);

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

  test('uploads a text attachment from the composer', async ({ page }) => {
    await signIn(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from playwright'),
    });

    await expect(page.getByText('e2e-note.txt')).toBeVisible();
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('e2e-note.txt')).toBeVisible();
  });

  test('records and uploads a voice message with browser recording APIs stubbed', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => new MediaStream(),
        },
      });

      class FakeMediaRecorder {
        ondataavailable: ((event: BlobEvent) => void) | null = null;
        onstop: (() => void) | null = null;
        state: RecordingState = 'inactive';

        constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}

        start(): void {
          this.state = 'recording';
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(['voice'], { type: 'audio/webm' }),
            } as BlobEvent);
          });
        }

        stop(): void {
          this.state = 'inactive';
          this.onstop?.();
        }
      }

      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: FakeMediaRecorder,
      });
    });

    await signIn(page);
    await page.getByTitle('Record voice message').click();
    await expect(page.getByText(/Recording/i)).toBeVisible();
    await page.getByTitle('Stop recording').click();
    await expect(page.locator('audio').last()).toBeVisible();
  });

  test('renders the seeded voice room route', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: /Voice Hall/i }).click();
    await expect(page).toHaveURL(/\/voice\//);
    await expect(page.getByText('Voice Hall').first()).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: /Voice Hall room chat/i }),
    ).toBeVisible();

    const composer = page.getByPlaceholder(/^Message/);
    const text = `voice side chat ${Date.now()}`;
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.getByText(text)).toBeVisible();
  });
});

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Username or email').fill('admin');
  await page.getByLabel('Password').fill('change-me-in-dev');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page).toHaveURL(/\/app/);
  await page.getByRole('link', { name: /lobby/i }).click();
}
