# Test Coverage Map

Snapshot of automated test coverage across Tavern's production code. Scope: every `.ts`/`.tsx` file under the listed source directories, mapped against the existing test suites (`apps/api/test`, `apps/api/test-integration`, `packages/shared/test`, `e2e/tests`). Vendor / generated files (`node_modules`, `packages/db/dist`, Prisma client output) are excluded.

## Summary

- **Total production files (in scope):** 109
  - API: 47 (`routes` 23, `services` 8, `lib` 8, `gateway` 1, app/index/config 3 — minus `apps/api/src/plugins/*` which is not in the requested scope but referenced; not counted)
  - Worker: 3
  - Shared: 29 (root 7 + schemas 22)
  - Media: 8
  - DB (TS only): 2
  - Web components: 15
  - Web lib: 8
  - Web routes: 13
- **Files with any test (unit / integration / E2E):** ~28 (26%)
- **Files with full coverage (unit + integration + E2E walkthrough touch):** 0
- **Files with NO test of any kind:** ~81 (74%)
- **Coverage estimate against the 80% target:** **~25% (statements/branches/lines, rough).** Vitest coverage instrumentation is not configured — there is **no numeric coverage threshold enforced anywhere**. The percentage above is computed by file-count, weighted by hand against the few covered files.

### Test files inventory

| Path | Type | Covers |
|------|------|--------|
| `apps/api/test/auth.test.ts` | Unit (fake Prisma) | `routes/auth.ts`, `services/auth-service.ts` (register/login/refresh/me/bootstrap-status/bootstrap-conflict). Mocks `@tavern/db` with `makeFakePrismaClient`. |
| `apps/api/test/helpers.ts` | Test infra | In-memory Prisma stub (`makeFakeDb`, `makeFakePrismaClient`) — only models `user`, `session`, `invite`. |
| `apps/api/test-integration/setup.ts` | Test infra | testcontainers Postgres bootstrap (`startPostgres` / `stopPostgres` / `isDockerAvailable`). Uses `prisma db push`. |
| `apps/api/test-integration/permissions.test.ts` | Integration (real Postgres) | `services/permissions-service.ts` — single happy-path test for channel overwrites; skips when Docker is absent. |
| `packages/shared/test/dice.test.ts` | Unit | `shared/dice.ts` — parser/evaluator (15 cases incl. caps, keep-h/l, modifiers, no-eval safety). |
| `packages/shared/test/ulid.test.ts` | Unit | `shared/ulid.ts` (4 cases). |
| `packages/shared/test/permissions.test.ts` | Unit | `shared/permissions.ts` — bitset math, base perms, channel overwrite stacking, owner/ADMINISTRATOR short-circuits. |
| `packages/shared/test/voice-schemas.test.ts` | Unit | `shared/schemas/voice.ts` — join response, voiceStateUpdate, gateway payload schemas. |
| `e2e/tests/golden-path.spec.ts` | E2E (Playwright) | Login -> open `#lobby` -> send message -> `/roll 1d20`. Single smoke test. |
| `e2e/tests/walkthrough.spec.ts` | E2E walkthrough | 18-step tour (login, message, dice, reaction, report dialog open/cancel, campaigns CRUD+tabs, board games CRUD, game night plan+vote, moderation queue + audit log, server settings tabs, search, channel create, sign-out). Produces frames + video for `pnpm walkthrough`. |

### `pnpm walkthrough` script

Defined in root `package.json`:
```
"walkthrough": "pnpm --filter @tavern/e2e test:walkthrough && pnpm --filter @tavern/e2e walkthrough:assemble"
```
Confirmed present, plus `walkthrough:headed` and `walkthrough:assemble` variants.

---

## Coverage Matrix

Legend for "E2E" column:
- `golden` = covered by `golden-path.spec.ts`
- `walk` = exercised by `walkthrough.spec.ts`
- `(touch)` = the route/component is hit indirectly but its behaviour is not asserted

### API Routes (`apps/api/src/routes/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `auth.ts` | 118 | apps/api/test/auth.test.ts | – | walk + golden (login only) | **PARTIAL** |
| `servers.ts` | 200 | – | – | walk (touch via list + lobby render) | NONE |
| `channels.ts` | 148 | – | – | walk (create channel step 17) | PARTIAL |
| `messages.ts` | 228 | – | – | golden + walk (send + dice; no edit/delete/react assertions) | PARTIAL |
| `roles.ts` | 156 | – | – | walk (Settings -> Roles tab visible only) | NONE |
| `overwrites.ts` | 114 | – | – | – | NONE |
| `reactions.ts` | 70 | – | – | walk (step 5 reacts with dice emoji, asserts visible) | PARTIAL |
| `emojis.ts` | 84 | – | – | walk (Emoji tab visible only) | NONE |
| `campaigns.ts` | 148 | – | – | walk (create + tabs) | PARTIAL |
| `sessions.ts` | 154 | – | – | walk (Sessions tab open) | NONE |
| `notes.ts` | 120 | – | – | walk (Notes tab open) | NONE |
| `dice.ts` | 114 | – | – | golden + walk (`/roll`) | PARTIAL |
| `board-games.ts` | 136 | – | – | walk (add game) | PARTIAL |
| `game-nights.ts` | 225 | – | – | walk (plan + vote) | PARTIAL |
| `moderation.ts` | 253 | – | – | walk (open queue + audit log render) | NONE |
| `handouts.ts` | 137 | – | – | walk (Handouts tab visible only) | NONE |
| `typing.ts` | 36 | – | – | walk (touch via composer use; not asserted) | NONE |
| `search.ts` | 80 | – | – | walk (input fills; result not asserted) | NONE |
| `uploads.ts` | 167 | – | – | – | NONE |
| `invites.ts` | 150 | – | – | – (only used at register in unit tests) | NONE |
| `attachments.ts` | 116 | – | – | – | NONE |
| `local-files.ts` | 115 | – | – | – | NONE |
| `voice.ts` | 237 | – | – | – | NONE |

### API Services (`apps/api/src/services/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `auth-service.ts` | 304 | apps/api/test/auth.test.ts | – | walk (login) | PARTIAL |
| `permissions-service.ts` | 152 | – | apps/api/test-integration/permissions.test.ts (1 case) | walk (touch) | PARTIAL |
| `gateway-broker.ts` | 133 | – | – | walk (touch via realtime fanout) | NONE |
| `queues.ts` | 101 | – | – | – | NONE |
| `upload-validator.ts` | 97 | – | – | – | NONE |
| `livekit-token.ts` | 53 | – | – | – | NONE |
| `storage.ts` | 37 | – | – | walk (touch) | NONE |
| `audit-service.ts` | 24 | – | – | walk (audit log opens but rows not asserted) | NONE |

### API Lib (`apps/api/src/lib/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `jwt.ts` | 89 | – (used indirectly by auth tests) | – | walk (touch) | NONE (no direct test) |
| `passwords.ts` | 22 | – (used by auth tests indirectly) | – | walk (touch) | NONE |
| `serializers.ts` | 203 | – | – | walk (touch) | NONE |
| `responses.ts` | 14 | – | – | walk (touch) | NONE |
| `invite-codes.ts` | 8 | – | – | – | NONE |
| `hash.ts` | 8 | – | – | – | NONE |
| `logger.ts` | 13 | – | – | walk (touch) | NONE |
| `load-env.ts` | 17 | – | – | – | NONE |

### API Gateway (`apps/api/src/gateway/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `index.ts` (WebSocket gateway) | 274 | – | – | walk (touch — realtime delivery during walkthrough) | NONE (no behavioural assertion) |

### API root (`apps/api/src/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `app.ts` | 174 | apps/api/test/auth.test.ts (constructs via buildApp authOnly) | – | walk (touch) | PARTIAL |
| `config.ts` | 120 | – | – | walk (touch) | NONE |
| `index.ts` | 28 | – | – | walk (touch) | NONE |

### Worker (`apps/worker/src/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `index.ts` | 103 | – | – | – | NONE |
| `config.ts` | 57 | – | – | – | NONE |
| `load-env.ts` | 12 | – | – | – | NONE |

### Shared package (`packages/shared/src/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `dice.ts` | 263 | packages/shared/test/dice.test.ts | – | golden + walk (touch) | PARTIAL (no edge cases on negative-mod-only, no overflow on faces*count) |
| `permissions.ts` | 205 | packages/shared/test/permissions.test.ts | apps/api/test-integration/permissions.test.ts | walk (touch) | PARTIAL (parsing edge cases, multiple-user-overwrites NOT tested) |
| `ulid.ts` | 86 | packages/shared/test/ulid.test.ts | – | walk (touch) | PARTIAL |
| `errors.ts` | 95 | – | – | walk (touch via thrown errors) | NONE |
| `constants.ts` | 82 | – | – | walk (touch) | NONE |
| `load-env.ts` | 33 | – | – | – | NONE |
| `index.ts` | 6 | – | – | – | NONE (pure re-export) |

### Shared schemas (`packages/shared/src/schemas/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `voice.ts` | 64 | packages/shared/test/voice-schemas.test.ts | – | – | PARTIAL |
| `auth.ts` | 58 | apps/api/test/auth.test.ts (touch — bodies are validated through register/login) | – | walk (touch) | PARTIAL |
| `messages.ts` | 62 | – | – | walk (touch) | NONE |
| `dice.ts` | 62 | – | – | walk (touch) | NONE |
| `gateway.ts` | 89 | – | – | walk (touch) | NONE |
| `channels.ts` | 62 | – | – | walk (touch) | NONE |
| `servers.ts` | 31 | – | – | walk (touch) | NONE |
| `roles.ts` | 31 | – | – | walk (touch) | NONE |
| `users.ts` | 30 | – | – | walk (touch) | NONE |
| `reactions.ts` | 42 | – | – | walk (touch) | NONE |
| `invites.ts` | 26 | – | – | – | NONE |
| `sessions.ts` | 58 | – | – | walk (touch) | NONE |
| `campaigns.ts` | 51 | – | – | walk (touch) | NONE |
| `attachments.ts` | 67 | – | – | – | NONE |
| `handouts.ts` | 36 | – | – | walk (touch) | NONE |
| `notes.ts` | 29 | – | – | walk (touch) | NONE |
| `board-games.ts` | 40 | – | – | walk (touch) | NONE |
| `game-nights.ts` | 64 | – | – | walk (touch) | NONE |
| `moderation.ts` | 150 | – | – | walk (touch) | NONE |
| `ids.ts` | 11 | – | – | walk (touch) | NONE |
| `index.ts` | 20 | – | – | – | NONE (re-export) |

### Media package (`packages/media/src/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `pipeline.ts` | 213 | – | – | – | NONE |
| `scanner.ts` | 134 | – | – | – | NONE |
| `storage/local.ts` | 210 | – | – | – | NONE |
| `storage/s3.ts` | 112 | – | – | – | NONE |
| `storage/types.ts` | 66 | – | – | – | NONE |
| `storage/index.ts` | 18 | – | – | – | NONE |
| `logger.ts` | 14 | – | – | – | NONE |
| `index.ts` | 3 | – | – | – | NONE (re-export) |

### DB package (`packages/db/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `src/index.ts` | 23 | – | apps/api/test-integration/setup.ts uses PrismaClient | walk (touch) | PARTIAL (only via integration setup) |
| `src/seed.ts` | 161 | – | – | walk depends on it (run `pnpm db:seed`) | NONE (no test asserting seed shape) |
| `prisma/schema.prisma` | n/a | – | apps/api/test-integration uses `prisma db push` against it | – | – |

### Web components (`apps/web/src/components/`)

No web unit-test directory exists (`apps/web/test/` is absent; `apps/web/package.json#test` is `vitest run --passWithNoTests`).

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `VoiceRoom.tsx` | 579 | – | – | – | NONE |
| `MessageComposer.tsx` | 253 | – | – | golden + walk | PARTIAL |
| `MessageList.tsx` | 177 | – | – | golden + walk | PARTIAL |
| `CreateCampaignModal.tsx` | 167 | – | – | walk | PARTIAL |
| `AttachmentView.tsx` | 145 | – | – | – | NONE |
| `ReportDialog.tsx` | 116 | – | – | walk (open + cancel only) | PARTIAL |
| `CreateChannelModal.tsx` | 105 | – | – | walk (step 17) | PARTIAL |
| `ScreenShareSettingsPopover.tsx` | 84 | – | – | – | NONE |
| `CreateServerModal.tsx` | 84 | – | – | – | NONE |
| `ReactionBar.tsx` | 62 | – | – | walk (add reaction) | PARTIAL |
| `Modal.tsx` | 52 | – | – | walk (touch) | NONE |
| `MemberSidebar.tsx` | 40 | – | – | walk (touch) | NONE |
| `TypingIndicator.tsx` | 38 | – | – | walk (touch) | NONE |
| `AuthGate.tsx` | 23 | – | – | walk + golden (touch) | NONE |
| `TavernLogo.tsx` | 22 | – | – | walk (touch) | NONE |

### Web lib (`apps/web/src/lib/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `store.ts` (zustand realtime store) | 171 | – | – | walk (touch) | NONE |
| `gateway-client.ts` | 131 | – | – | walk (touch — realtime fanout) | NONE |
| `auth.ts` | 122 | – | – | walk + golden (touch) | NONE |
| `api-client.ts` | 117 | – | – | walk + golden (touch) | NONE |
| `realtime.ts` | 90 | – | – | walk (touch) | NONE |
| `uploads.ts` | 75 | – | – | – | NONE |
| `cn.ts` | 56 | – | – | walk (touch) | NONE |
| `waveform.ts` | 48 | – | – | – | NONE |

### Web routes (`apps/web/src/routes/`)

| File | LoC | Unit | Integration | E2E | Status |
|------|----:|------|-------------|-----|--------|
| `app-shell.tsx` | 381 | – | – | walk (touch) | NONE |
| `campaigns-page.tsx` | 594 | – | – | walk | PARTIAL |
| `games-page.tsx` | 554 | – | – | walk (board games + nights) | PARTIAL |
| `server-settings-page.tsx` | 543 | – | – | walk (Roles/Members/Emoji/Safety tabs) | PARTIAL |
| `moderation-page.tsx` | 307 | – | – | walk (queue + audit log open) | PARTIAL |
| `bootstrap-page.tsx` | 142 | – (auth.test exercises bootstrap API only) | – | – | NONE |
| `register.tsx` | 99 | – | – | – | NONE |
| `search-page.tsx` | 87 | – | – | walk (search fills) | PARTIAL |
| `login.tsx` | 85 | – | – | walk + golden | PARTIAL |
| `channel-page.tsx` | 51 | – | – | walk + golden | PARTIAL |
| `server-home.tsx` | 34 | – | – | walk (touch) | NONE |
| `voice-page.tsx` | 24 | – | – | – | NONE |
| `app-home.tsx` | 16 | – | – | walk (touch) | NONE |

---

## E2E Gaps

These flows have **no E2E assertion** today (note: many open the screen in the walkthrough but never check behaviour):

1. **First-run bootstrap.** `/bootstrap` page has no E2E test (the walkthrough starts from a seeded admin via `pnpm db:seed`). The route file `apps/web/src/routes/bootstrap-page.tsx` and `POST /api/auth/bootstrap` are uncovered end-to-end.
2. **File upload + attachment display.** No test uploads an image or file. `routes/uploads.ts`, `routes/attachments.ts`, `routes/local-files.ts`, `components/AttachmentView.tsx`, `lib/uploads.ts` are all uncovered.
3. **Voice room lifecycle.** No test joins voice, no LiveKit token mint, no participant render. `routes/voice.ts` (237 LoC), `services/livekit-token.ts`, `components/VoiceRoom.tsx` (579 LoC) — none exercised.
4. **Screen share controls.** `ScreenShareSettingsPopover.tsx` has zero coverage; permission to stream is enforced by `permissions.ts` STREAM_SCREEN, but no E2E demonstrates allow/deny.
5. **Dice command edge cases.** Only `1d20` (golden) and `4d6kh3` (walkthrough) are exercised in the UI. Negative rolls, percentile `d%`, disadvantage `2d20kl1`, error handling on invalid notation — none asserted end-to-end (parser unit tests cover, but the route + UI surface isn't).
6. **Campaign safety lines/veils after creation.** Walkthrough fills "graphic horror" once but never reopens the campaign to verify the line persisted.
7. **Moderation actions.** The walkthrough opens the queue and audit log but never acts (no ban, no mute, no report disposition, no role change). `routes/moderation.ts` (253 LoC) has zero behavioural assertion.
8. **Multi-user real-time delivery.** Every E2E test runs as a single browser context. There is **no test** that opens two sessions and asserts that user B receives user A's message via the gateway. The single biggest realtime-correctness risk is uncovered.
9. **Reaction toggling and full message lifecycle.** Walkthrough adds a reaction but never removes it; never edits or deletes a message; never asserts MESSAGE_UPDATE / MESSAGE_DELETE gateway fanout.
10. **Invite acceptance.** `routes/invites.ts` is only exercised through the register test's `TEST-INVITE` path inside the unit suite; no E2E covers `/invite/:code` -> redeem -> join server.
11. **Search results.** The search input is filled but `expect` never inspects the result list. `routes/search.ts` is uncovered behaviourally.
12. **Role + permission overwrite changes.** Walkthrough opens the Roles tab but doesn't create/edit a role or a per-channel overwrite. `routes/roles.ts`, `routes/overwrites.ts` have NO behavioural coverage.
13. **Custom emoji upload.** Walkthrough opens the Emoji tab but doesn't add one. `routes/emojis.ts` uncovered.
14. **Refresh token rotation under realistic timing.** Unit tests cover happy-path rotation; no E2E covers session expiry + auto-refresh in the web client.
15. **Handouts and notes content roundtrip.** Tabs opened, but no create/edit/delete asserted.
16. **Game night vote uniqueness.** Walkthrough votes once; no check that voting again is idempotent or that a second user can vote.

---

## Test Infrastructure Findings

### Vitest

- **Coverage threshold: NOT SET.** Neither root nor any per-package `vitest.config.ts` declares `test.coverage` — no `c8`/`v8` provider, no `lines`/`branches`/`statements`/`functions` thresholds. `vitest --coverage` is not wired into any script.
- `apps/api/vitest.config.ts` — `node` env, `globals: false`, 20s test/hook timeout, includes `test/**/*.test.ts`.
- `apps/api/vitest.integration.config.ts` — separate config for `test-integration/**`. Uses `pool: 'forks', singleFork: true` and a 120s timeout. Good isolation.
- `packages/shared/vitest.config.ts` — node env, includes `test/**/*.test.ts`. No coverage config.
- `apps/web/package.json` test script is `vitest run --passWithNoTests` — no `vitest.config.ts` file at all; the web workspace effectively skips testing today.
- `apps/worker/package.json` test script is `vitest run --passWithNoTests` — no tests in the worker.
- `packages/media/package.json` test script is `vitest run --passWithNoTests` — no tests in the media package.

### Playwright

- `e2e/playwright.config.ts`:
  - Base URL: `http://localhost:3030` (env-overridable).
  - Retries: **2 in CI, 0 locally**. Good.
  - Trace: `on-first-retry`.
  - Video: `retain-on-failure` (the chromium project); `mode: 'on'` for the walkthrough project.
  - Two projects: `chromium` (smoke) and `walkthrough` (relaxed pace).
  - Timeout: 5 minutes per test, 10s for expect.
  - Reporter: `github` + `line` in CI, `list` locally.
- No global setup that boots the dev stack — Playwright assumes `pnpm dev` is already running. Reproducible, but not hermetic.

### CI

- **No `.github/workflows/` directory.** Search returned zero files. There is NO automated CI running tests on push or PR. All testing is local / manual.
- This means: no coverage drift gating, no regression gate on PRs, no E2E smoke as a merge guard, no Playwright artifact upload on failure.

### Test data and isolation

- Unit tests (`apps/api/test/auth.test.ts`) use a hand-rolled in-memory Prisma stub (`makeFakePrismaClient`). Coverage is limited to `user`/`session`/`invite` models — adding a unit test for any route that touches `server`/`channel`/`message`/`role`/etc. will need either an expansion of the stub or a switch to integration tests. **Confirmed: `makeFakePrismaClient` exists at `apps/api/test/helpers.ts`.**
- Integration tests (`apps/api/test-integration/`) spin up a real Postgres via testcontainers, run `prisma db push`, share a single fork. Tests skip cleanly via `describe.skipIf(!dockerOk)`. Currently only one test file exists.
- E2E tests assume the seed has run (`admin@example.com` / `change-me-in-dev` / `DEV-INVITE`). They mutate shared state across runs (each walkthrough creates a uniquely-stamped campaign / game / channel) — they don't reset between runs and don't conflict on names, but they accumulate data in the dev DB. Not a problem for a smoke suite, would be for property tests.
- No fixture factories. Test setup duplicates the user / server / role / channel construction inline (see `permissions.test.ts` ll. 45–88). Refactor opportunity.

### Mock patterns

- `vi.hoisted` + `vi.mock('@tavern/db')` pattern in `auth.test.ts` is correct (hoisted ref pattern) but only the auth flows use it. Reproducing it for other route suites will be repetitive — extracting a shared `withFakePrisma()` helper in `apps/api/test/helpers.ts` would lower the barrier to backfilling unit tests for messages, channels, etc.

---

## Priority Test Backfill (ranked)

### P0 (CRITICAL — block any fix that touches these without a test)

1. **`apps/api/src/routes/messages.ts`** (228 LoC, 0 unit/0 integration). Send, edit, delete, nonce idempotency, ULID-as-cursor pagination, permission gating via `READ_MESSAGE_HISTORY`/`SEND_MESSAGES`, sanitization. The most-used surface in the app with zero behavioural assertion.
2. **`apps/api/src/gateway/index.ts`** (274 LoC, 0 tests). HELLO/IDENTIFY/HEARTBEAT/RESUME state machine, sequence buffering, per-recipient permission filtering of dispatches. A single integration test asserting two clients receive each other's MESSAGE_CREATE is the highest-leverage check we don't have.
3. **`apps/api/src/services/permissions-service.ts`** (152 LoC, 1 integration test). The integration test covers exactly ONE scenario (single @everyone deny). Stacking of @everyone + role + user overwrites against a real Postgres is the bug magnet; the unit tests in `packages/shared/test/permissions.test.ts` cover the math but not the data-loading paths.
4. **`apps/api/src/services/auth-service.ts`** (304 LoC). Lockout windows, failed-attempt counter increments, refresh-token replay detection, password hash invariants. The auth unit tests cover the happy paths but not the lockout / brute-force defences.
5. **`apps/api/src/routes/uploads.ts` + `apps/api/src/services/upload-validator.ts` + `packages/media/src/pipeline.ts` + `packages/media/src/scanner.ts`** (~600 LoC combined, 0 tests). Validation of extension blocklist, MIME mismatch, size caps, EXIF stripping, ClamAV signature handling, quarantine on FAIL. Security-critical; **no unit, no integration, no E2E** today.
6. **`apps/api/src/lib/jwt.ts`** (89 LoC). Token signing, audience/issuer claims, expiry, refresh-token signature mismatch. Used indirectly through auth tests but no direct property tests.

### P1 (HIGH — backfill during the next maintenance pass)

7. **`apps/api/src/routes/voice.ts` + `services/livekit-token.ts`** (290 LoC combined). LiveKit grant shape, screen-share allow-deny based on STREAM_SCREEN, identity collision, room name format. Plus E2E join-voice happy path.
8. **`apps/api/src/routes/reactions.ts`** + `routes/roles.ts` + `routes/overwrites.ts`. The bit-level perms checks here are subtle; unit tests with the fake Prisma would catch most regressions cheaply.
9. **`apps/api/src/routes/moderation.ts`** (253 LoC). Ban / mute / report-disposition endpoints; audit-trail correctness.
10. **`packages/media/src/storage/local.ts` + `storage/s3.ts`** (322 LoC combined). PUT-ticket signing, key sanitisation, quarantine bucket migration. Critical for self-hosted operators.
11. **`apps/web/src/lib/gateway-client.ts`** (131 LoC) + **`apps/web/src/lib/store.ts`** (171 LoC). WebSocket reconnect/resume logic and reducer behaviour. Unit-testable with a fake WS.
12. **`apps/web/src/components/VoiceRoom.tsx`** (579 LoC — the largest single web file). At minimum a component test that mounts in jsdom and asserts permission-gated UI; ideally an E2E that joins voice via the LiveKit dev fixture.
13. **Multi-user E2E.** Add a Playwright test using two browser contexts (`browser.newContext()`) — Alice posts, Bob sees it within 1s. Covers gateway + store + render together.
14. **Bootstrap E2E.** Wipe the seed, hit `/bootstrap`, create the admin, verify the redirect to `/app`.

### P2 (MEDIUM)

15. **`apps/api/src/routes/invites.ts`** — create / revoke / accept; expiry; max-uses; server vs instance scope.
16. **`apps/api/src/routes/campaigns.ts` / `sessions.ts` / `notes.ts` / `handouts.ts` / `board-games.ts` / `game-nights.ts`** — CRUD endpoints with permission gates.
17. **`apps/api/src/routes/search.ts`** — assert the result shape and snippet generation.
18. **`apps/api/src/lib/serializers.ts`** (203 LoC) — pure functions, very cheap to unit-test for Date->ISO and Decimal->string roundtrips on each entity.
19. **`apps/api/src/lib/responses.ts` / `hash.ts` / `invite-codes.ts` / `logger.ts`** — small enough that test cost is trivial; even smoke tests would catch regressions.
20. **`packages/shared/src/errors.ts`** — `TavernError` codes, status mapping.
21. **All un-tested `packages/shared/src/schemas/*.ts`** — auth schema is touched indirectly; the rest (messages, gateway, campaigns, moderation, etc.) deserve at least one positive + one rejection case each.
22. **`packages/db/src/seed.ts`** — assert the post-seed shape (admin, invite, server, channels) so changes to seed don't silently regress the walkthrough.
23. **`apps/worker/src/index.ts`** — at minimum a smoke test that the processor wires through to `runScanJob` and shuts down cleanly on SIGTERM.
24. **`apps/web/src/lib/uploads.ts` / `waveform.ts` / `realtime.ts` / `auth.ts` / `api-client.ts`** — small pure helpers; jsdom unit tests would catch most regressions.
25. **`apps/web/src/components/*` un-touched components** (`CreateServerModal`, `Modal`, `MemberSidebar`, `TypingIndicator`, `AuthGate`, `TavernLogo`, `AttachmentView`, `ScreenShareSettingsPopover`) — testing-library component tests.

---

## Recommendations

1. **Wire coverage instrumentation.** Add `@vitest/coverage-v8` to each workspace's `vitest.config.ts`, set `coverage.thresholds.lines/branches/functions/statements = 80` (start lower if needed and ratchet up — e.g. start at 25 and bump per release).
2. **Add a GitHub Actions workflow** under `.github/workflows/test.yml` running, in parallel: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration` (with a Postgres service container), and `pnpm test:e2e` (with `pnpm dev` in the background). Upload Playwright traces + the walkthrough video as artifacts on failure.
3. **Promote the fake-Prisma helper.** Generalise `makeFakePrismaClient` to cover the entity types the rest of the routes need (`server`, `serverMember`, `role`, `channel`, `message`, `reaction`, `permissionOverwrite`, `attachment`, `invite`, `auditLogEntry`). Add a `withFakeApi()` helper that returns a fully wired Fastify instance with the fake. This unblocks ~70% of the P0/P1 unit-test backfill.
4. **Create `apps/web/test/`** with a `vitest.config.ts` (`environment: 'jsdom'`, `@testing-library/react`) and at least one component test (e.g. `MessageList`) to set the precedent.
5. **Add a second integration test file per route module** as you backfill — the testcontainers harness is already proven; cost per additional test is low because Postgres only spins up once per file.
6. **Add a multi-context Playwright test** — `e2e/tests/realtime.spec.ts` — opening two contexts as two users; asserts MESSAGE_CREATE / VOICE_STATE_UPDATE / TYPING_START all fan out correctly.
7. **Add a bootstrap E2E** — `e2e/tests/bootstrap.spec.ts` — using `prisma migrate reset --force --skip-seed` in `globalSetup` for a clean slate.
8. **Add an upload E2E** — covers the `routes/uploads.ts` + worker pipeline path end to end with a small JPEG fixture; asserts the EXIF strip and quarantine flow with a deliberate EICAR file.
9. **Pin `pnpm walkthrough` as a release-gate.** Wire it into CI on `main`; upload the assembled MP4 as a release artifact for documentation.
10. **Document the test pyramid expectation** in `CLAUDE.md` — currently the project has no testing policy; add a one-paragraph summary so contributors know what's required.
