# Recording a video walkthrough

The `walkthrough` Playwright project drives the entire app end-to-end in a
real browser, with an on-screen banner narrating each step, and saves the
session as a `.webm` video. It's a watchable demo *and* a regression check —
if any of the flows it touches break, the walkthrough fails loudly.

## What it covers

The walkthrough is `e2e/tests/walkthrough.spec.ts`. It runs through:

1. Sign in as the seeded admin
2. Land in the seeded server's lobby
3. Send a text message
4. Roll dice (`/roll 4d6kh3`)
5. React to a message
6. Open and cancel the report dialog
7. Open the Campaigns page
8. Create a campaign with a safety-boundary entry
9. Tour the campaign Sessions / Notes / Handouts tabs
10. Open the Games & nights page
11. Add a board game to the library
12. Plan a game night with the new game as a candidate
13. Vote for the candidate
14. Open the Moderation queue + Audit log tabs
15. Open Server settings and tour all four tabs (Roles / Members / Emoji / Safety policy)
16. Search messages
17. Create a new text channel
18. Sign out

What it does **not** cover (and why):

- **Joining a voice/video room** — that needs `docker compose --profile livekit up`
  and a real LiveKit token. The button in the sidebar is shown but not clicked.
- **Recording a voice message** — Playwright can grant mic permission, but
  headless Chromium doesn't have an audio device to actually record from.
  Demonstrate this manually if you need it on camera.

## Run it

```powershell
# 1. Stack up
pnpm docker:up
pnpm db:migrate
pnpm db:seed

# 2. Dev servers (api + worker + web) — leave running in another terminal
pnpm dev

# 3. One-time: install Chromium
pnpm --filter @tavern/e2e install-browsers

# 4. Record
pnpm walkthrough
```

The recording takes ~60–90 seconds depending on machine speed. When it
finishes the video lands at:

```
e2e/test-results/walkthrough-Tavern-walkthrough-walkthrough/video.webm
```

(Playwright derives the directory name from the project + describe + test
title — the suffix may vary slightly between Playwright versions.)

## Convert to MP4 if needed

GitHub, Slack, etc. accept `.webm` directly. If you need `.mp4`:

```powershell
ffmpeg -i video.webm -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p walkthrough.mp4
```

## See it visibly while it runs

```powershell
pnpm --filter @tavern/e2e test:walkthrough:headed
```

This drops the headless flag, so a Chromium window opens and you can watch
the walkthrough drive the app live.

## Reset between recordings

Each run creates `Walkthrough campaign <stamp>`, `Walkthrough Game <stamp>`,
etc. Re-running just adds more entries; nothing collides. To start completely
fresh:

```powershell
pnpm db:reset && pnpm db:seed
```
