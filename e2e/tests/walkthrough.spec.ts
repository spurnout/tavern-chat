import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tavern walkthrough — produces a watchable tour of the app as a sequence of
 * numbered PNG screenshots, then assembled into video via:
 *
 *   pnpm walkthrough             # records frames
 *   pnpm walkthrough:assemble    # ffmpeg → walkthrough.mp4 (or HTML fallback)
 *
 * Why screenshots and not Playwright's built-in video recording?
 *
 * Playwright's video recorder in headless Chromium frequently produces blank
 * frames on Windows (and sometimes elsewhere) because it captures from the
 * compositor, which can fail without GPU acceleration. Screenshots use the
 * DevTools `Page.captureScreenshot` CDP path, which is much more reliable.
 *
 * Side benefit: each frame holds long enough to read the on-screen banner,
 * which is more useful than a continuous video for a feature tour.
 *
 * The test still ALSO records a .webm via the playwright config — if it
 * happens to come out fine on your machine, great; if not, you have the
 * stitched MP4.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = path.resolve(__dirname, '..', 'walkthrough-frames');

let frameCounter = 0;

test.beforeAll(() => {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  frameCounter = 0;
});

const PAUSE_SHORT = 500;
const PAUSE_MEDIUM = 1000;
const PAUSE_LONG = 1600;

async function snap(page: Page): Promise<void> {
  frameCounter++;
  await page.screenshot({
    path: path.join(FRAMES_DIR, `${String(frameCounter).padStart(3, '0')}.png`),
  });
}

async function annotate(page: Page, label: string): Promise<void> {
  await page.evaluate((text) => {
    const win = window as unknown as { __walkthroughAnnotate?: (s: string) => void };
    win.__walkthroughAnnotate?.(text);
  }, label);
  await page.waitForTimeout(PAUSE_SHORT);
  await snap(page);
}

async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

test.describe.configure({ mode: 'serial' });

test('Tavern walkthrough', async ({ page }) => {
  const stamp = Date.now();

  // Inject a step-banner helper that survives navigations.
  await page.addInitScript(() => {
    const win = window as unknown as { __walkthroughAnnotate?: (s: string) => void };
    win.__walkthroughAnnotate = (text: string) => {
      const tryRender = () => {
        if (!document.body) {
          window.requestAnimationFrame(tryRender);
          return;
        }
        let el = document.getElementById('__walkthrough_banner__');
        if (!el) {
          el = document.createElement('div');
          el.id = '__walkthrough_banner__';
          el.style.cssText = [
            'position:fixed',
            'left:50%',
            'bottom:24px',
            'transform:translateX(-50%)',
            'background:rgba(249,115,22,0.96)',
            'color:#0c0a09',
            'padding:12px 22px',
            'border-radius:10px',
            'font:600 18px/1.4 Inter,system-ui,-apple-system,Segoe UI,sans-serif',
            'box-shadow:0 8px 20px rgba(0,0,0,0.55)',
            'z-index:2147483647',
            'max-width:80vw',
            'pointer-events:none',
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = text;
      };
      tryRender();
    };
  });

  // ────────── 1. Sign in ──────────────────────────────────────────────
  await page.goto('/');
  // Give the SPA a moment to render before the first frame, otherwise we
  // capture a flash-of-blank.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await pause(page, PAUSE_MEDIUM);
  await annotate(page, '1. Sign in as the seeded admin');
  await page.getByLabel('Username or email').fill('admin');
  await page.getByLabel('Password').fill('change-me-in-dev');
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app/);

  // ────────── 2. Land in the lobby ────────────────────────────────────
  await annotate(page, '2. Land in the seeded server\'s lobby');
  await page.getByRole('link', { name: /lobby/i }).first().click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 3. Send a message ───────────────────────────────────────
  await annotate(page, '3. Send a text message');
  const composer = page.getByPlaceholder(/^Message/);
  await composer.fill(`Hello from the walkthrough — ${stamp}`);
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await composer.press('Enter');
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 4. Roll dice ────────────────────────────────────────────
  await annotate(page, '4. Roll dice — /roll 4d6kh3 (D&D ability score)');
  await composer.fill('/roll 4d6kh3');
  await pause(page, PAUSE_SHORT);
  await composer.press('Enter');
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 5. Add a reaction ───────────────────────────────────────
  await annotate(page, '5. React to a message');
  const addReactionButton = page.getByRole('button', { name: /add reaction/i }).last();
  await addReactionButton.click({ force: true });
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await page.getByRole('button', { name: '🎲' }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 6. Open report dialog ───────────────────────────────────
  await annotate(page, '6. Open the report dialog (then cancel)');
  const reportButton = page.getByRole('button', { name: /report message/i }).last();
  await reportButton.click({ force: true });
  await pause(page, PAUSE_LONG);
  await snap(page);
  await page.getByRole('dialog').getByRole('button', { name: /cancel/i }).click();
  await pause(page, PAUSE_MEDIUM);

  // ────────── 7. Open Campaigns page ──────────────────────────────────
  await annotate(page, '7. Open the Campaigns page');
  await page.getByRole('link', { name: /campaigns/i }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 8. Create a campaign ────────────────────────────────────
  await annotate(page, '8. Create a campaign with safety lines & veils');
  await page.getByRole('button', { name: /new campaign/i }).click();
  await pause(page, PAUSE_SHORT);
  const campaignDialog = page.getByRole('dialog');
  await campaignDialog.getByLabel('Name').fill(`Walkthrough campaign ${stamp}`);
  await campaignDialog.getByLabel('Game system').fill('D&D 5e');
  await campaignDialog
    .getByLabel('Description')
    .fill('Demo campaign created by the walkthrough.');
  await campaignDialog.getByRole('button', { name: /^\+ add$/i }).click();
  await campaignDialog.getByPlaceholder(/topic/i).fill('graphic horror');
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await campaignDialog.getByRole('button', { name: /create campaign/i }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 9. Browse campaign tabs ─────────────────────────────────
  await annotate(page, '9. Tour the campaign tabs');
  await page.getByRole('button', { name: /^Notes$/ }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);
  await page.getByRole('button', { name: /^Handouts$/ }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);
  await page.getByRole('button', { name: /^Sessions$/ }).click();
  await pause(page, PAUSE_SHORT);

  // ────────── 10. Open Games & Nights page ────────────────────────────
  await annotate(page, '10. Open Games & nights');
  await page.getByRole('link', { name: /games/i }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 11. Add a board game ────────────────────────────────────
  await annotate(page, '11. Add a board game to the library');
  await page.getByRole('button', { name: /add game/i }).click();
  await pause(page, PAUSE_SHORT);
  const gameDialog = page.getByRole('dialog');
  await gameDialog.getByLabel('Name').fill(`Walkthrough Game ${stamp}`);
  await gameDialog.getByLabel('Description').fill('A demo entry');
  await gameDialog.getByLabel('Min players').fill('2');
  await gameDialog.getByLabel('Max players').fill('5');
  await gameDialog.getByLabel('Minutes').fill('45');
  await gameDialog.getByLabel(/Tags/i).fill('demo, party');
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await gameDialog.getByRole('button', { name: /^add$/i }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 12. Plan a game night ───────────────────────────────────
  await annotate(page, '12. Plan a game night with the new game');
  await page.getByRole('button', { name: /plan a night/i }).click();
  await pause(page, PAUSE_SHORT);
  const nightDialog = page.getByRole('dialog');
  await nightDialog.getByLabel('Title').fill(`Friday demo night ${stamp}`);
  await nightDialog.getByLabel('Location (optional)').fill('Someone\'s living room');
  await nightDialog.getByText(`Walkthrough Game ${stamp}`).click();
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await nightDialog.getByRole('button', { name: /^plan$/i }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 13. Vote on the candidate ───────────────────────────────
  await annotate(page, '13. Vote for the candidate game');
  await page.getByRole('button', { name: /0 votes/i }).first().click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  // ────────── 14. Open Moderation ─────────────────────────────────────
  await annotate(page, '14. Open the moderation queue');
  await page.getByRole('link', { name: /moderation/i }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);
  await annotate(page, '14b. …and the audit log');
  await page.getByRole('button', { name: /audit log/i }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 15. Server settings ─────────────────────────────────────
  await annotate(page, '15. Server settings — Roles tab');
  await page.getByRole('link', { name: /^Settings$/ }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  await annotate(page, '15b. Members tab');
  await page.getByRole('button', { name: /Members/ }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  await annotate(page, '15c. Custom emoji tab');
  await page.getByRole('button', { name: /Emoji/ }).click();
  await pause(page, PAUSE_MEDIUM);
  await snap(page);

  await annotate(page, '15d. Server safety policy');
  await page.getByRole('button', { name: /Safety policy/ }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 16. Search ──────────────────────────────────────────────
  await annotate(page, '16. Search messages on this server');
  await page.getByRole('link', { name: /^Search$/i }).click();
  await pause(page, PAUSE_SHORT);
  await page.getByPlaceholder(/Search messages/i).fill('walkthrough');
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 17. Create a new channel ────────────────────────────────
  await annotate(page, '17. Create a new text channel');
  await page.getByRole('button', { name: /^Create channel$/ }).click();
  await pause(page, PAUSE_SHORT);
  const channelDialog = page.getByRole('dialog');
  await channelDialog.getByLabel('Name').fill(`tour-${stamp}`);
  await channelDialog.getByLabel('Topic (optional)').fill('Created by the walkthrough.');
  await pause(page, PAUSE_SHORT);
  await snap(page);
  await channelDialog.getByRole('button', { name: /create channel/i }).click();
  await pause(page, PAUSE_LONG);
  await snap(page);

  // ────────── 18. Sign out ────────────────────────────────────────────
  await annotate(page, '18. Sign out');
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await annotate(page, "That's it — fin.");
  await pause(page, PAUSE_LONG);
  await snap(page);
});
