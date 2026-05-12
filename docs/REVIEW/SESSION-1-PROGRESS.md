# Code Review Session 1 — Progress Report

**Date:** 2026-05-11
**Branch:** main (no commits yet — fixes layered on top of in-progress working tree)

## Phase 1 — Review sweep ✅

7 parallel review subagents produced **184 findings** across 7 slices, consolidated into
[BACKLOG.md](BACKLOG.md):

| Severity | Count |
|----------|-------|
| CRITICAL | 17    |
| HIGH     | 57    |
| MEDIUM   | 66    |
| LOW      | 44    |

## Phase 2 — Triage ✅

BACKLOG.md sorted by severity/slice with cross-cutting-theme analysis.

## Phase 3a — CRITICAL fixes — 15 of 17 ✅ / 2 remaining

### Applied (15 critical + 2 bonus)

| ID | Slice | Fix |
|----|-------|-----|
| **FE-01** | frontend | `vite.config.ts`: `sourcemap: true` → `'hidden'` (no source map URLs shipped to browsers) |
| **INF-001** | infra | Added `LICENSE` file (MIT) at repo root |
| **INF-002** | docs | `docs/deployment.md`: corrected `docker compose up` to use `--profile apps` and added `pnpm garage:bootstrap` step |
| **INF-003** | docs | `docs/native-setup.md`: instruct copying `garage.toml.example`, not the git-ignored materialized file |
| **INF-004** | infra | `infra/traefik/dynamic.yml`: web service URL now points to nginx port 80, not 3000 |
| **STO-001** | uploads | `apps/api/src/routes/local-files.ts`: hard 403 on quarantine-bucket reads (mirrors S3 attachments route) |
| **UPL-001** | uploads | `apps/api/src/routes/uploads.ts`: `GET /api/attachments/:id` returns 404 to non-owners for quarantined/blocked/failed attachments |
| **PERM-001** | permissions | Added `requireRoleHierarchy` helper; enforced on `POST/PATCH /api/roles` and `PUT /api/servers/:id/members/:userId/roles` — cannot grant a role above your own or with permissions you don't hold |
| **RT-001** | realtime | `apps/api/src/routes/voice.ts`: VOICE_STATE_UPDATE events now carry `channelId` in the envelope so the gateway's per-recipient `shouldDeliver` evaluates VIEW_CHANNEL (no more presence leak across hidden voice rooms) |
| **SEC-002** | security | `apps/api/src/services/auth-service.ts` register: atomic `updateMany` with `uses: { lt: maxUses }` predicate — no more invite-use race |
| **SEC-003** | security | New `PATCH /api/auth/password` route + `AuthService.changePassword` (verifies current pw, rotates Argon2 hash, revokes ALL active sessions for the user) |
| **SEC-004** | security | `GET /api/auth/bootstrap-status` rate-limited to 30/min |
| **DB-001** | database | `loadMemberContext`: collapsed 3 serial Prisma round-trips into a single nested-include query |
| **DB-002** | database | `filterVisibleChannels`: O(N·5) → 3 queries (member context + channels + batched overwrites), regardless of N |
| **DB-004** | database | `apps/api/src/routes/messages.ts`: include-fetch moved inside the create transaction; removed the redundant post-commit `findUnique` |
| **SEC-018** (bonus, was MEDIUM) | security | Server-scoped invites now rejected for instance registration |
| **DB-006** (bonus, was HIGH) | database | `getChannelPermissions` no longer re-queries `Server.defaultRoleId` (already on member context) |

### Remaining CRITICAL (3 large changes)

| ID | Why deferred to next session |
|----|------------------------------|
| **SEC-001 / FE-02** — refresh token in localStorage | Cookie migration touches `apps/api/src/routes/auth.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/lib/auth.ts`, CORS config, all existing auth tests. Requires careful coordination of dev (HTTP) vs prod (HTTPS) cookie attributes. |
| **PERM-002** — BAN_MEMBERS unimplemented | Requires a Prisma schema migration (new `ServerBan` model), new routes (`POST /api/servers/:id/bans`, `DELETE …`), gateway IDENTIFY enforcement, and audit-log integration. |
| **DB-003** — full-text search ILIKE | Requires a Prisma migration enabling `pg_trgm` extension and adding a GIN index on `Message.content`. The query in `search.ts` already uses `contains` so the search-side change is minimal, but the migration is a one-way schema event. |

## Verification

After every fix batch:
- `pnpm typecheck` ✅ all 7 workspaces green
- `pnpm lint` ✅ all 7 workspaces green
- `pnpm test` ✅ 46 shared + 11 api = **57 tests passing**

The fake-Prisma test helper at `apps/api/test/helpers.ts` was extended with `invite.updateMany` to support the new atomic invite-consume path.

## Files touched this session (Phase 3a)

- `LICENSE` (new)
- `apps/web/vite.config.ts`
- `infra/traefik/dynamic.yml`
- `docs/native-setup.md`
- `docs/deployment.md`
- `apps/api/src/routes/local-files.ts`
- `apps/api/src/routes/uploads.ts`
- `apps/api/src/routes/roles.ts`
- `apps/api/src/routes/voice.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/messages.ts`
- `apps/api/src/services/auth-service.ts`
- `apps/api/src/services/permissions-service.ts`
- `apps/api/test/helpers.ts`
- `packages/shared/src/errors.ts`
- `packages/shared/src/schemas/auth.ts`

## Next session

1. Finish the 3 remaining CRITICAL findings (SEC-001 cookies, PERM-002 bans, DB-003 pg_trgm). These should each be their own session/commit because they involve schema or cross-app coordination.
2. Begin Phase 3b on the 57 HIGH findings — start with realtime (`shouldDeliver` for channelId-less events, broker fallback bug RT-006, backpressure RT-002), then frontend silent-catch UX wave, then DB index migration batch.
3. Phase 4 (integration test backfill) gates on at least the routes touched in Phase 3a having tests against a real Postgres.
