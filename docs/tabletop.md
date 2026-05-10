# Tabletop & board games

Tavern is built for gaming groups. The tabletop and board-game features are
first-class.

## Campaigns

A **campaign** lives inside a server, has a Game Master, and can have any
number of players, sessions, notes, and handouts. Campaigns can be linked to
specific channels — a campaign typically owns at least one text channel and
one voice channel.

### Schema

Stored in `Campaign`. Notable fields:

- `gameSystem` — free-text label (e.g. "D&D 5e", "Blades in the Dark").
- `status` — `planning | active | paused | completed | archived`.
- `safetyBoundariesJson` — see [safety.md](safety.md).
- `defaultChannelId` — the campaign's "main" text channel, if any.

### Permissions

- `CREATE_CAMPAIGNS` — server-wide capability.
- `MANAGE_CAMPAIGNS` — edit any campaign on the server.
- The campaign's `gmUserId` always has full control of the campaign.
- `MANAGE_CAMPAIGN_NOTES` — moderators of campaign notes.
- `VIEW_GM_NOTES` — see notes flagged `gm_only`. Default: GM only.
- `MANAGE_HANDOUTS` / `VIEW_PRIVATE_HANDOUTS` — handout administration.

## Sessions

A **session** is a scheduled meeting of a campaign. Sessions track:

- start/end time
- assigned voice & text channels
- agenda + recap
- RSVPs

Sessions broadcast `CAMPAIGN_SESSION_CREATE` / `CAMPAIGN_SESSION_UPDATE` over
the gateway so calendars and dashboards update live.

## Notes

Free-form markdown notes attached to a campaign. Each note has a visibility
of `public_to_party` or `gm_only`. The GM can pin important notes.

## Handouts

Handouts are richer than notes — they can carry attachments (maps, images,
PDFs) and have three visibilities:

- `public_to_party` — every campaign member can see it.
- `gm_only` — only the GM (and `VIEW_PRIVATE_HANDOUTS`) can see it.
- `specific_players` — visibility limited to a specific list of users.

## Dice

Dice notation is parsed by a hand-written safe parser. **No `eval` is ever
called.** Supported notation:

```
d6
1d20
2d6
4d6kh3       (keep highest 3)
2d20kl1      (disadvantage)
1d20+5
2d6 - 3
d%           (1d100)
```

Limits (configurable, see `DICE_LIMITS` in
[`packages/shared/src/constants.ts`](../packages/shared/src/constants.ts)):

- max dice per roll: 100
- max faces per die: 1000
- max notation length: 128 characters

Each roll is stored as a `DiceRoll` row, structured (so the UI can render the
individual dice and which were kept), and visibility-tagged:

- `public` — broadcast to the channel.
- `gm_only` — visible only to the GM.
- `private` — visible only to the roller.

## Board games

A **board game** is a server-scoped game library entry. Tavern doesn't try to
be a BoardGameGeek clone — just enough metadata to plan game nights:

- min/max players
- play time minutes
- complexity (1–5, freeform)
- tags
- optional cover image

## Game nights

A **game night** is a scheduled hangout where the group might play one or
more games. The flow is:

1. Someone proposes a game night (with optional candidate games + voice
   channel + scheduled time).
2. Members RSVP `yes / no / maybe / late`.
3. Members propose additional candidate games (`POST /game-nights/:id/candidates`).
4. Members vote for the candidate they want to play.
5. The organizer marks the chosen game as `selectedBoardGameId`.

Game nights also broadcast `GAME_NIGHT_CREATE` / `GAME_NIGHT_UPDATE` over the
gateway.
