# Screenshots

This folder holds the images embedded in the root [`README.md`](../../README.md)
**Screenshots** section.

The README currently points at on-brand **placeholder** images
(`placehold.co`). To make it show the real app, drop PNGs into this folder
using the filenames below and switch the README links to the local paths
(each placeholder has the local `<img>` ready to uncomment right beside it).

## Expected files

| Filename | Surface to capture | Suggested route |
|----------|--------------------|-----------------|
| `chat.png` | A server with categories + a busy text channel (replies, reactions, an embed) | `/` → any room |
| `voice.png` | A voice/video room — active-speaker grid, screen share or participants | a voice channel |
| `campaign.png` | A tabletop campaign dashboard — sessions, notes, handouts | Campaigns → a campaign |
| `tabletop-tools.png` | Dice roll in chat + GM screen or combat tracker overlay | in-session view |
| `game-nights.png` | Board-game library and/or a game-night vote | Games / Game nights |
| `moderation.png` | Moderation queue with bulk actions, or the safety policy panel | Server settings → Safety |
| `onboarding.png` | Guided welcome screen for a new member | first-join / onboarding flow |
| `federation.png` | Remote members tagged with their home instance, or peer settings | member list / federation settings |
| `mobile.png` | Responsive layout at a narrow viewport (~390–420px wide) | any room, mobile width |

All three of the last rows are wired into the README's extras row. Capture
`mobile.png` at a phone-width viewport so it matches the tall placeholder slot.

## How to regenerate

1. Boot the stack and seed it:
   ```bash
   pnpm docker:up:full        # or: pnpm dev  (with local Postgres)
   pnpm db:seed
   ```
2. Open <http://localhost:3030>, log in as `admin` / `change-me-in-dev`,
   and create a little demo content (a room or two, a campaign, a game night).
3. Capture at a consistent size — **1200×750** (or 2400×1500 @2x for retina
   crispness) keeps the README grid tidy. Browser devtools device toolbar or
   a full-page screenshot extension both work; for `mobile.png` use a ~390px
   viewport.
4. Save into this folder with the filenames above (PNG, optimized).
5. In the root README, swap each placeholder `<img src="https://placehold.co/...">`
   for the local `<img src="docs/screenshots/<file>.png">` already provided as a
   commented line next to it.

> Tip: `pnpm walkthrough` drives the app end-to-end via Playwright and is a
> handy way to reach each surface in a known-good state before grabbing a shot.

## Guidelines

- Use the seeded demo data, not real member content.
- Prefer the **dark** theme — it matches the badge/placeholder palette.
- Keep PII out of frame (real names, emails, invite codes).
- Optimize PNGs (e.g. `oxipng`/`pngquant`) so the repo stays light.
