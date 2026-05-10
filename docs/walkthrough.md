# Recording a video walkthrough

`pnpm walkthrough` produces a watchable tour of the app as:

- **`e2e/walkthrough.html`** — a self-contained slideshow you can open in any
  browser. PNGs are embedded as base64 so the file stands alone (mail it,
  upload it to Slack, etc.). Always produced.
- **`e2e/walkthrough.mp4`** — produced when `ffmpeg` is on PATH. ~30 frames
  at ~2.5s each, 1280px wide, H.264.

The frames themselves live in `e2e/walkthrough-frames/NNN.png` if you want
to use them directly.

## Why screenshots and not Playwright's video recording?

Playwright records video by capturing from Chromium's compositor. In headless
mode on Windows (and sometimes elsewhere) the compositor can't render without
a GPU and produces blank frames — a white, empty `.webm`. Screenshots use a
different code path (`Page.captureScreenshot` over CDP) that doesn't have that
problem.

Side benefit: each frame holds long enough on screen to read the orange
banner labelling the step. For a feature tour that's more useful than a
real-time video where labels flash by.

## What the walkthrough covers

`e2e/tests/walkthrough.spec.ts`, 18 numbered steps:

1. Sign in as the seeded admin
2. Land in the seeded server's lobby
3. Send a text message
4. Roll dice (`/roll 4d6kh3` — D&D ability score)
5. React to a message with a quick-pick emoji
6. Open and cancel the report dialog
7. Open the Campaigns page
8. Create a campaign with a "graphic horror" safety boundary
9. Tour the campaign Sessions / Notes / Handouts tabs
10. Open the Games & nights page
11. Add a board game to the library
12. Plan a game night with the new game as a candidate
13. Vote for the candidate
14. Open the Moderation queue + Audit log tabs
15. Tour all four Server settings tabs (Roles / Members / Emoji / Safety)
16. Search messages
17. Create a new text channel
18. Sign out

What it does **not** cover:

- **Joining a voice/video room** — needs `docker compose --profile livekit up`
  and a real LiveKit token. The button in the sidebar is shown but not clicked.
- **Recording a voice message** — Playwright can grant mic permission, but
  headless Chromium has no audio device to record from. Demonstrate manually
  if you need it on camera (use `pnpm walkthrough:headed`).

## Run it

```powershell
# 1. Stack up
pnpm docker:up
pnpm db:migrate
pnpm db:seed

# 2. Dev servers — leave running in another terminal
pnpm dev

# 3. One-time: install Chromium
pnpm --filter @tavern/e2e install-browsers

# 4. Record + assemble in one go
pnpm walkthrough
```

The recording takes ~60 seconds. When it finishes:

- Open `e2e/walkthrough.html` in any browser to play the slideshow.
- If `ffmpeg` was on PATH, also `e2e/walkthrough.mp4` will exist.

To re-stitch existing frames without re-running the test:

```powershell
pnpm walkthrough:assemble
```

To change frame timing:

```powershell
SECONDS_PER_FRAME=4 pnpm walkthrough:assemble
```

## See it visibly while it runs

```powershell
pnpm walkthrough:headed
```

Drops the headless flag — Chromium opens visibly so you can watch the
walkthrough drive the app live. Useful for capturing a screen recording
of a feature that the spec can't reach (voice recording, voice rooms).

## Reset between recordings

Each run creates `Walkthrough campaign <stamp>`, `Walkthrough Game <stamp>`,
etc. Re-running just adds more entries; nothing collides. To start completely
fresh:

```powershell
pnpm db:reset && pnpm db:seed
```

## Convert MP4 to GIF if needed

For a short loop suitable for embedding:

```powershell
ffmpeg -i e2e/walkthrough.mp4 -vf "fps=10,scale=960:-1:flags=lanczos" -loop 0 walkthrough.gif
```
