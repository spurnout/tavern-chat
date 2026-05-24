# Track I — Docs vs Reality Drift

## Critical / High

**[DOC] `docs/roadmap.md` describes IR20 federation as "no code yet" — Phases 1–6 are fully shipped.** `docs/roadmap.md:184` vs `docs/federation-operations.md:1–10` and `docs/federation.md:1–9`. "Design doc at federation.md; **no code yet.**" is fossilized. Phases 1–6 implemented (peering, remote-user identity, channel messages, invites + Tavern mirroring, 1:1 federated DMs, federated presence). Replace with "Shipped" entry; Phases 7–8 named as pending.

**[DOC] `CLAUDE.md` layout table omits `packages/federation`.** `CLAUDE.md` (Layout block) vs `ls packages/`: `db/ federation/ media/ shared/`. Layout lists shared/db/media — silent on federation. Agents planning federation work won't know where shared federation schemas live.

**[DOC] `docs/permissions.md` bit-table omits `MANAGE_NICKNAMES` at bit 50.** `docs/permissions.md` vs `packages/shared/src/permissions.ts:83–84`. Source defines `MANAGE_NICKNAMES: 1n << 50n`. docs/permissions.md says "Bits 50–61 are reserved." Bit 50 is actively used. `docs/api.md:75` even references `MANAGE_NICKNAMES` for `PATCH /servers/:serverId/members/:userId`.

## Medium

**[DOC] `docs/api.md` missing a large set of route files.** ~20 documented vs 81 actual. Undocumented: slash, inbox, pins, saved, threads, polls, scheduled, encounters, link-previews, random-tables, tokens-webhooks, ical, stickers, battle-maps, campaign-calendar, encounter-templates, automod, warnings, join-gates, server-templates, push, rss, admin-storage, member-directory, member-status, npcs, characters, compendium, server-backup, drafts, soundboard, campaign-safety, decks, imports, watch-party, captions, recaps, breakouts, recordings, plugins, whiteboard, totp, sso, webauthn, federation-* (6), account, moderation-actions, admin-federation, well-known.

**[DOC] `docs/deployment.md` step 5 raw `docker compose` commands don't chain `garage:bootstrap`.** `docs/deployment.md:64–68` vs step 6 at 77–80. Operator using raw commands skips garage bootstrap.

**[DOC] `docs/deployment.md` does not document `OIDC_AUTO_LINK_BY_EMAIL` or multi-replica Redis for OIDC/WebAuthn.** `docs/deployment.md` vs `docs/production-hardening.md:86–93, 162–165`. Pass 1 added the hardening docs but deployment guide doesn't mirror.

**[DOC] `docs/federation-operations.md` has a stale phase-status paragraph alongside the up-to-date one.** `docs/federation-operations.md:33` says per-Tavern + per-channel opt-in settings "do not exist yet" — `Server.federationEnabled` and `Channel.federationMode` exist and are documented in Phase 3 of the same file (~308–316).

**[DOC] `docs/roadmap.md` IR20 entry in Planned Directions does not reflect Phases 1–6 shipped.** Replace "Planned" block with "Shipped" summary; Phase 7 (moderation propagation) and Phase 8 (voice) called out as pending.

**[DOC] `docs/design-system.html` uses `fg-default` / `accent-ember` token names that differ from `docs/design-system.md` and `CLAUDE.md`.** `docs/design-system.html:220`. CLAUDE.md says `text-fg`, `text-fg-muted`, `bg-ember`, `bg-tint-ember`. Token-name inconsistency in the canonical design doc.

## Low / Nits

**[DOC] `docs/deployment.md` step 7 runs `pnpm db:migrate` but not `db:seed`.** `docs/deployment.md:87–89`. README runs both. Without seed, fresh prod has no admin user.

**[DOC] `CLAUDE.md` "Other docs" list missing federation docs.** `CLAUDE.md:67`. Doc list should include `docs/federation.md`, `docs/federation-operations.md`, `docs/federation-followups.md`.

**[DOC] `docs/docker-setup.md` references `infra/garage/garage.toml` as committed; it is generated.** `docs/docker-setup.md:47–48`.

**[STYLE] `docs/federation.md` "Open design questions" section is stale.** `docs/federation.md:63–84`. Status banner says all 7 locked; section header still says "resolve these first". Rename to "Design decisions (locked)".

**[?] `README.md` layout block omits `packages/media` and `packages/federation`.** `README.md:29–39`.

## Notes

Per-doc summary:
- **README.md** — federation paragraph (Pass 1) accurate. Layout tree omits media + federation packages.
- **CLAUDE.md** — layout omits packages/federation; "Other docs" missing federation docs; ESLint `tavern-*` claim correct; port 3030 matches.
- **docs/architecture.md** — clean.
- **docs/api.md** — significantly underdocumented (~60 missing routes).
- **docs/permissions.md** — MANAGE_NICKNAMES bit 50 missing; otherwise matches.
- **docs/deployment.md** — missing `OIDC_AUTO_LINK_BY_EMAIL` + multi-replica Redis; garage bootstrap flow ambiguous.
- **docs/production-hardening.md** — Pass 1 additions accurate.
- **docs/native-setup.md** — Node 22+/pnpm 9+/PG 16+ match. Clean.
- **docs/docker-setup.md** — accurate; garage.toml note slightly misleading.
- **docs/safety.md** — clean.
- **docs/tabletop.md** — clean.
- **docs/walkthrough.md** — scripts verified.
- **docs/roadmap.md** — two drift items (no code yet for IR20, federation absent from Verified results).
- **docs/federation.md** — phase banner accurate; "Open design questions" section stale.
- **docs/federation-operations.md** — one stale sentence line 33.
- **docs/federation-followups.md** — living doc; consistent.
- **docs/design-system.html** — `tavern-*` deprecation correct; token-name inconsistency vs CLAUDE.md.
