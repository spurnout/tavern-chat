# Code Review Notes — Tavern

> Three-pass review log. First pass: read everything and capture findings.
> Second pass: fix safe contained issues. Third pass: summary.

## Progress

- [x] First pass — packages/shared
- [x] First pass — packages/db
- [x] First pass — packages/media
- [x] First pass — packages/federation
- [x] First pass — apps/api
- [x] First pass — apps/worker
- [x] First pass — apps/web
- [x] First pass — scripts + infra
- [x] Second pass — fix issues (typecheck + lint + 343 unit tests all green)
- [x] Final pass — report (this file)

## Pass 2 — Progress

- [x] Read pass — apps/web voice/composer/SW (Track A)
- [x] Read pass — apps/web state/realtime (Track B)
- [x] Read pass — apps/web wave-4 federation UI (Track C)
- [x] Read pass — apps/api federation services (Track D)
- [x] Read pass — apps/api routes/services/auth/gateway (Track E)
- [x] Read pass — apps/worker + jobs (Track F)
- [x] Read pass — packages/* (Track G)
- [x] Read pass — infra/scripts/tests/config (Track H)
- [x] Read pass — docs vs reality drift (Track I)
- [x] Fix pass — safe contained fixes inline (typecheck + lint + 396 unit tests all green)
- [x] Final pass — Pass 2 report (this file)

Tags: **[BUG] [SEC] [PERF] [STYLE] [DOC] [?]**.

---

## Findings, with resolution status

### Critical / High

- [x] **[SEC] SSRF in link-preview unfurl.** `apps/api/src/services/link-preview-service.ts`. Fetched message-supplied URLs with `redirect: 'follow'` and no host check; `OG_FETCH_ENABLED=true` opened an SSRF read primitive (response body fields are echoed back).
  **Resolved** — added `assertValidPeerHost` guard, replaced auto-redirect with manual hop-by-hop logic (max 4 hops, each re-validated), and rejected non-http(s) schemes.
- [x] **[SEC] SSRF + missing timeout in OIDC service.** `apps/api/src/services/oidc-service.ts`. Both the discovery doc fetch and the token-endpoint fetch had no timeout or host check; a hostile `OIDC_ISSUER_URL` or a discovery doc pointing `token_endpoint` at an internal host could be coerced to make internal requests.
  **Resolved** — added `assertValidPeerHost` on both URLs, an 8s `AbortController` timeout, and bounded the in-memory `states` map to 1024 entries (was unbounded).
- [x] **[BUG] WEBP magic-byte check incomplete.** `packages/media/src/pipeline.ts`. Only the leading `RIFF` magic was checked; any RIFF container (.wav, .avi) could have been accepted as `image/webp`.
  **Resolved** — restructured the magic-bytes table to support multi-signature AND-checks. WEBP now requires both `RIFF` at offset 0 and `WEBP` at offset 8.
- [x] **[SEC] OIDC email-match auto-link is account-takeover-prone.**
  **Resolved** — added `OIDC_AUTO_LINK_BY_EMAIL` config flag (default `true` for back-compat; see "Low / nits" section for the same item).

### Medium

- [x] **[DOC] README claimed "It does not federate."**
  **Resolved** — rewrote `README.md` lines 12–18 to describe opt-in federation off by default via `FEDERATION_ENABLED`.
- [x] **[BUG] gateway-client.ts reconnect could produce double-sockets.**
  **Resolved** — added `'reconnecting'` to the `connect()` early-out, null the reconnect timer in `close()` / `scheduleReconnect()` / on timer fire, and clear state transition before reconnect.
- [x] **[BUG] OIDC synthetic email collisions.**
  **Resolved** — added `uniqueEmail()` helper that appends `+N` to the localpart on collision, mirroring `uniqueUsername`.
- [x] **[BUG] Federation outbox-worker retry math spuriously dead-lettered every job.** `apps/worker/src/federation-outbox-worker.ts:124` used `?? 0`; undefined `attempts` made `>= 0` always true.
  **Resolved** — default to `Infinity`; an `UnrecoverableError` is still recognised as truly exhausted, so the legitimate dead-letter signal still fires.
- [x] **[STYLE] `REMOTE_USER_ID_RE` duplicated** across three federation schema files.
  **Resolved** — moved to `packages/shared/src/federation/constants.ts`; the three files now import the single source of truth.
- [x] **[STYLE] federation verify accepted arbitrary `eventType`** (asymmetric with `sync-dispatch`).
  **Resolved** — `verifyTwoLayerMessageEnvelope` now uses `z.enum(ENVELOPE_EVENT_TYPES)`.
- [x] **[BUG] forum thread root assumes content has visible text.**
  **Resolved** — `createMessageRequestSchema` now uses `.superRefine` to require non-empty content OR at least one attachment OR a `forwardedFromMessageId`. The "Untitled thread" branch is now unreachable for the empty-content case.
- [x] **[SEC] WebAuthn challenges + OIDC states are per-process.**
  **Resolved** — added `apps/api/src/lib/ephemeral-store.ts` with `InMemoryEphemeralStore` + `RedisEphemeralStore` backends. Both `WebAuthnService` and `OidcService` now take an injected `EphemeralStore`; `app.ts` picks the Redis backend when `REDIS_URL` is set so multi-replica deployments work.
- [x] **[BUG] `AccountDataSection` polls indefinitely.**
  **Resolved** — split the effect; the 4 s `setInterval` only runs while there's a non-terminal export row.
- [x] **[PERF] image normalisation buffers entire object.**
  **Resolved** — replaced `Buffer.concat(chunks)` + 3× `sharp(buf)` with `stream.pipe(sharp())` + `decoder.clone()` for each output. Sharp now buffers internally only what it needs; peak resident memory drops materially under concurrent image jobs.

### Low / nits

- [x] **[STYLE] `ulid.ts` dead `Math.random()` fallback.**
  **Resolved** — fallback replaced with a clear throw. Node 18+ has `globalThis.crypto`; if some future target doesn't, we want a hard failure rather than silently downgrading randomness.
- [x] **[STYLE] `seed.ts` `void Permission;` noise.**
  **Resolved** — removed the import and the no-op statement.
- [x] **[STYLE] Garage-bootstrap arg validation + NaN-safe timeout.**
  **Resolved** — added `assertSafeArgValues()` check (`^[A-Za-z0-9._-]+$`) before passing env values to `docker exec /garage`, and made `GARAGE_HEALTH_TIMEOUT_MS` `Number.isFinite`-guarded.
- [ ] **[STYLE] `link-preview-service` user-agent.** Updated to point at `https://github.com/tavern-app/tavern` while applying the SSRF fix.
  **Resolved** (in the same diff).
- [x] **[STYLE] sound.ts unprefixed localStorage keys.**
  **Resolved** — keys now use the `tavern.` prefix the rest of the codebase uses; the unprefixed legacy names are still read as a one-time fallback for users upgrading.
- [x] **[?] `with-env.mjs` uses `spawn(..., { shell: true })`.**
  **Resolved** — `shell:true` now only enabled on Windows (where it's needed for `.cmd` resolution); the command name is rejected if it contains shell metacharacters as defence-in-depth.
- [x] **[?] auth plugin extra User lookup per request.**
  **Resolved** — combined Session + User into a single Prisma query via the `user` relation. Halves the per-request DB round-trips for authenticated routes.
- [x] **[?] DNS-rebinding TOCTOU in `ssrf-guard.ts`.**
  **Resolved** — added `apps/api/src/lib/pinned-fetch.ts` using undici's `Agent` with a custom DNS `lookup` that pins to a pre-resolved IP. The hostname is resolved once, every IP it returns is checked against an extended block-list (RFC 1918 + loopback + link-local + ULA + multicast + CGNAT + reserved), and the fetch is dialled directly at the pinned IP (with SNI/Host still set to the hostname). Both link-preview and OIDC now go through it.
- [x] **[SEC] OIDC email-match auto-link is account-takeover-prone.**
  **Resolved** — added `OIDC_AUTO_LINK_BY_EMAIL` config flag (default `true` for back-compat). Operators with multi-IdP setups can flip it to `false` and unmatched SSO users will provision a new account instead of silently inheriting an existing one by email.

---

## Verification

After applying every "Resolved" fix (including the deferred pass):

- `pnpm typecheck` — clean across 8 workspaces.
- `pnpm lint` — clean across 8 workspaces.
- `pnpm test` — **343 tests pass** (apps/api 119, packages/shared 205, packages/federation 10, apps/worker 5, apps/web 4). The Redis ECONNREFUSED noise in the test log is just the `EphemeralStore`'s shared Redis client logging a connect attempt against the `redis://localhost:6379` from `TEST_CONFIG` — the `on('error')` handler swallows it and the in-memory fallback kicks in.

---

## Pass 2

A second full-repo pass run on 2026-05-23 (the agent's perspective). Same three-pass methodology as Pass 1: read everything, fix safe contained issues inline, defer architectural items with rationale. Eight read tracks dispatched in parallel as subagents, fragments saved under `.review/pass2/` and consolidated here. **36 files modified across 7 workspaces, +658/-113 lines.**

### Critical / High

- [x] **[BUG] Inbound federation `message.create` and `dm.message.create` have no `MAX_CLOCK_SKEW` guard on `createdAt`.** `apps/api/src/services/federation-inbound.ts:1263, 3432`. Pass 1's commit 0a0d89e added the skew guard to `editedAt` and `deletedAt`, but the initial `createdAt` was still `new Date(payload.createdAt)` with no bounding. A peer holding a valid envelope-signing key can backdate a message hours or days into the past without violating the envelope's `notBefore/notAfter` window, re-ordering the receiver's timeline retroactively.
  **Resolved** — added `assertCreatedAtWithinSkew()` helper that parses the ISO string and asserts the timestamp is within the same `MAX_CLOCK_SKEW_MS` (5 min) window, and applied it to both message-create handlers.
- [x] **[BUG] `handlePresenceUpdate` host check is case-sensitive; DNS labels are case-insensitive.** `apps/api/src/services/federation-inbound.ts:4096`. A peer whose discovery doc uses `a.example` but emits envelopes with `userRemoteUserId = "alice@A.Example"` was rejected with `not_home_instance`. Other host comparisons in the file (dm.create recipient check) already normalise to lowercase.
  **Resolved** — `userHost.toLowerCase() !== peer.host.toLowerCase()`. Symmetric with the DM handler.
- [x] **[SEC] Invite `maxUses` race in the local-join path.** `apps/api/src/routes/invites.ts:280–322`. `findUnique → uses >= maxUses guard → update { uses: { increment: 1 } }` was three separate statements with no row lock. N concurrent redeems on a `maxUses=1` invite all passed the guard and all incremented, producing `maxUses + (N-1)` successful joins. The registration path in `auth-service.ts` already used the correct atomic pattern; the invite-join route did not.
  **Resolved** — wrapped in `prisma.$transaction` with a conditional `updateMany({ where: { id, uses: { lt: maxUses } } })` and a `count === 0` check; `serverMember.create` is now in the same txn so a constraint violation rolls back the increment.
- [x] **[SEC] `notificationclick` SW handler trusted `event.notification.data.url` without origin validation.** `apps/web/public/sw.js:108`. A malformed or hostile push payload could redirect the browser to an arbitrary URL via `openWindow`.
  **Resolved** — URL is parsed against `self.location.origin`, anything that resolves to a different host is rejected and falls back to `/app`. The `matchAll` window-focus check was also tightened from `includes` to a strict `pathname.startsWith` match (was focusing unrelated tabs whose URL happened to contain the path as a substring).
- [x] **[SEC] `ALLOW_UNSCANNED_UPLOADS` default was `true` in both api and worker configs.** `apps/api/src/config.ts:72`, `apps/worker/src/config.ts:17`. The production guard only fires when `NODE_ENV=production` AND the flag is `true` AND `CLAMAV_HOST` is unset. An operator who set `NODE_ENV=production` with an unreachable `CLAMAV_HOST` still launched, and uploads passed through unscanned the moment the clamd socket failed.
  **Resolved** — default flipped to `'false'` in both configs; `.env.example` updated with the new behaviour (rejected uploads when scanner missing).
- [x] **[BUG] `ServerInvitesPanel` revoke had no confirmation guard.** `apps/web/src/components/ServerInvitesPanel.tsx:155`. The Trash2 button fired `void revoke(r.id)` directly — an accidental click permanently invalidated an active invite with no undo. f8b2fd3 introduced `RevokePeerModal` exactly to prevent this class of mistake.
  **Resolved** — wrapped in a `pendingRevoke` state and a `ConfirmDialog` modal, matching the peer-revoke pattern.
- [x] **[BUG] `AdminFederationPage.approve()` silently swallowed errors.** `apps/web/src/routes/admin-federation-page.tsx:43`. No try/catch around the api() call; a 403 or 5xx produced no UI feedback. `revoke` and the dead-letter actions already had try/catch — `approve` was the lone exception.
  **Resolved** — added try/catch with `setError(...)`, mirroring the surrounding methods.
- [x] **[SEC] `quick-reactions` endpoint had effectively no permission check.** `apps/api/src/routes/reactions.ts:93`. The call was `requireChannelPermission(serverId, …)` — wrong overload (channel vs. server id) so it always 404'd — and the `.catch(() => undefined)` swallowed the throw. Non-members could enumerate emoji used server-wide.
  **Resolved** — switched to `requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL)`, which throws 403 for non-members.
- [x] **[BUG] Reaction DELETE swallowed all errors, not just missing-row.** `apps/api/src/routes/reactions.ts:300`. A bare `catch { /* idempotent */ }` masked DB connection failures; gateway/federation fan-out then fired for a reaction that was not actually removed.
  **Resolved** — narrowed to `Prisma.PrismaClientKnownRequestError && code === 'P2025'`; anything else re-throws.
- [x] **[BUG] Voice channel-switch emitted no leave-event for the previous channel.** `apps/api/src/routes/voice.ts:173`. `voiceState.upsert` atomically moved the row to channel B and broadcast `VOICE_STATE_UPDATE` scoped to channel B. Viewers of channel A (who may not be members of B) never saw the user leave — the avatar lingered until they reloaded.
  **Resolved** — capture the prior `channelId` before the upsert; if it differs from the join target, emit a separate `VOICE_STATE_UPDATE` scoped to the OLD channel with the new state (the client's `applyVoiceState` evict-then-place handles the rest).
- [x] **[BUG] BullMQ maintenance jobs had no `attempts`/`backoff`.** `apps/worker/src/index.ts:205–239`. Default `attempts: 1` + `removeOnFail: false` meant a single transient DB hiccup permanently marked the daily retention sweep failed until the next cron tick.
  **Resolved** — `attempts: 3, backoff: { type: 'exponential', delay: 30_000 }` on all four scheduled jobs (`audit-retention`, `nonce-cleanup`, `expired-custom-status`, `federation-envelope-retention`). `removeOnFail` switched to `{ count: 10 }` so failed entries don't accumulate unbounded.

### Medium

- [x] **[BUG] Federation-envelope-retention / audit-retention deletes were unbounded.** `apps/worker/src/index.ts:177-180, 119-122`. `prisma.deleteMany` issues a single `DELETE` with no `LIMIT`. On a busy instance that missed several daily sweeps, a multi-million-row delete would hold row-level locks for the full duration and amplify WAL pressure, stalling federation replication and audit-log inserts for seconds.
  **Resolved** — new `pruneInBatches()` helper chunks deletes at 5,000 rows per pass and yields between passes (`setImmediate`) so concurrent jobs and the BullMQ heartbeat don't starve.
- [x] **[SEC] `REDIS_URL` was logged at INFO on worker startup.** `apps/worker/src/index.ts:58`. Connection string can carry credentials (`redis://:password@host:port`); log aggregators retain them indefinitely.
  **Resolved** — new `redactRedisUrl()` strips userinfo before logging; the redacted form (`redis://[redacted]@host:port`) preserves the host:port for diagnostics.
- [x] **[BUG] Worker `shutdown()` had no deadline — `worker.close()` could block indefinitely.** `apps/worker/src/index.ts:249`. A hung in-flight scan (slow clamd, network stall) kept the process alive past Docker's `stop_grace_period`; the resulting SIGKILL lost the BullMQ lock and stalled the job until the lock duration expired.
  **Resolved** — wrapped the drain in `Promise.race` against an 8-second deadline; on timeout, log a warning and exit 1 anyway.
- [x] **[PERF] `expired-custom-status` had an N+1 query.** `apps/worker/src/index.ts:148-174`. Per expired user, a separate `serverMember.findMany` — 100 expired users = 101 round trips.
  **Resolved** — single query with `select: { id: true, memberships: { select: { serverId: true } } }`; fan-out walks the eager-loaded relation.
- [x] **[BUG] `expandTemplate` (dice) injected user-controlled stat values without validation.** `packages/shared/src/dice/template.ts:86`. `MAX_NOTATION_LENGTH` was checked on the pre-expansion template, not on the result. A `{stats:atk}` template (11 chars) could expand to an arbitrarily long string, bypassing the parser's length cap and exposing sheet content in subsequent parse errors.
  **Resolved** — stat values are now sanitised before substitution: reject anything that contains characters outside `[-+\sd0-9]` or exceeds 32 chars, with a clear `TemplateError`.
- [x] **[BUG] ClamAV scanner resolved an empty / malformed response as `{ clean: false }` instead of rejecting.** `packages/media/src/scanner.ts:111`. A clamd crash mid-stream silently quarantined every upload that followed, with no signature distinguishing real detections from infrastructure failures.
  **Resolved** — empty and unrecognised responses now `reject` with a typed error so callers can fall back to the `ALLOW_UNSCANNED_UPLOADS` path or quarantine intentionally.
- [x] **[SEC] Local storage wrote attachments with default OS umask (typically 0644).** `packages/media/src/storage/local.ts:147, 177`. Attachments are user-private; group/world readable was wrong on shared hosts.
  **Resolved** — both the streaming path (`createWriteStream`) and buffered path (`writeFileSync`) now pass `mode: 0o600`.
- [x] **[PERF] `User.remoteInstanceId` had no `@@index` despite being a FK.** `packages/db/prisma/schema.prisma`. Peer revocation and "list all users from instance X" queries did a sequential scan on what will become the largest table in the system. `RemoteUser` already had the symmetric index.
  **Resolved** — added `@@index([remoteInstanceId], map: "User_remoteInstanceId_idx")` plus an additive migration `20260523200000_user_remote_instance_index/migration.sql` with `CREATE INDEX IF NOT EXISTS`.
- [x] **[BUG] Plugin-loader hooks had no per-call timeout.** `apps/api/src/services/plugin-loader.ts:140`. Plugins run in-process at operator trust (no VM sandbox is intentional per the file header); a hung hook (infinite loop, stalled HTTP) blocked the route handler that dispatched it indefinitely.
  **Resolved** — `dispatchHook` now races each plugin against a 5 s deadline using `Promise.race`; the deadline arm logs `tavern.plugin.hook_timeout` and the `allSettled` outer continues with the rest. `setTimeout(...).unref?.()` prevents the deadline from holding the event loop open.
- [x] **[BUG] `inbox-store.hydrateReadStates` replaced the entire `readStatesByChannel` map.** `apps/web/src/lib/inbox-store.ts:66`. Any `MENTION_CREATE` that landed via the gateway between the HTTP call start and resolution was silently dropped (replaced wholesale by the snapshot). The bell badge could reset backward on reconnect.
  **Resolved** — merge instead of replace: for each channel, take the per-channel max `mentionCount` (snapshot vs. live), and prefer the more recent `lastReadAt`. Newly-arrived events survive the hydration.
- [x] **[BUG] `inbox-store.ackMention` did two separate `set()` calls.** `apps/web/src/lib/inbox-store.ts:127`. A concurrent gateway event between the two sets caused `totalUnreadMentions` to be recomputed against post-event state. Same single-`set` pattern that `ackChannel` / `ackAllMentions` already follow.
  **Resolved** — folded both updates into a single `set` callback.
- [x] **[BUG] `FederatedInvitePreviewModal` accept was vulnerable to a double-click race.** `apps/web/src/components/FederatedInvitePreviewModal.tsx:80`. The `accepting` state flag was set inside the async function but React batching meant two near-simultaneous clicks both read `accepting === false` and both fired the POST.
  **Resolved** — added a synchronous `inFlightRef` set before any await; second click bails immediately. Also: navigate-then-close (was close-then-navigate, leaving the user stranded on the invite page if navigate threw), and `inviterRemoteUserId.slice(0, 64)` so a hostile peer can't overflow the modal description with a 500-char identifier.
- [x] **[BUG] `RecordingControls` had no unmount cleanup.** `apps/web/src/components/RecordingControls.tsx:46`. The host leaving the voice room mid-recording left the `MediaRecorder` and `AudioContext` running in the background — the browser's audio-capture indicator stayed lit and the captured blob was never uploaded.
  **Resolved** — backstop `useEffect` cleanup that stops the recorder + closes the AudioContext + clears chunks on unmount. Bonus: swapped `recorder.start(1000)` and `await api('/recording/start', …)` order so a refused start doesn't leave a running recorder, and the catch branch now actively tears down whatever managed to start.
- [x] **[BUG] `MessageComposer` leaked preview blob URLs on unmount.** `apps/web/src/components/MessageComposer.tsx:106`. The unmount cleanup tore down the recorder but didn't revoke `pending[].previewUrl` — every navigated-away pending attachment leaked an object URL for the lifetime of the page.
  **Resolved** — added a `pendingRef` mirror of the latest `pending` array, and the cleanup now iterates and revokes every `previewUrl`.
- [x] **[BUG] `VoiceRoom.stateTimer` debounce could fire after unmount.** `apps/web/src/components/VoiceRoom.tsx:235`. Inside the 200 ms debounce callback, `stateTimer.current` was set to `null` BEFORE any unmount cleanup ran, so the join-effect's `clearTimeout` (which reads `stateTimer.current`) became a no-op if the unmount landed mid-microtask.
  **Resolved** — added a top-level `mountedRef` and a cheap `if (!mountedRef.current) return;` guard inside the debounce callback. Also removed the duplicate `me` from the breakout effect's deps array (had both `me?.id` and `me`, causing extra tear-down/re-register on every unrelated User field update); added an explicit `eslint-disable-next-line` with rationale for the `me?.id`-only deps.
- [x] **[BUG] `LiveCaptions` setTimeout for clearing the local line was never cancelled.** `apps/web/src/components/LiveCaptions.tsx:71`. An `enabled` flip-off or unmount within 800 ms of a final caption fired `setLocalLine('')` on a stale closure (React 18 swallows the warning but the state update is real).
  **Resolved** — stored the timer handle and cancelled it in the effect's cleanup, also cancelling any prior timer when a new final caption arrives.
- [x] **[PERF] `WatchPartyPanel` polled every 5 s regardless of whether a party existed.** `apps/web/src/components/WatchPartyPanel.tsx:64`. For the common case (no party in the room) it still hit `/voice/:channelId/watch-party` every 5 s for the entire voice session.
  **Resolved** — interval only starts when `party !== null`; effect re-runs on that flag flipping.
- [x] **[PERF] `app-shell.tsx` channel list used `?? []` literal fallback.** `apps/web/src/routes/app-shell.tsx:164`. A fresh `[]` on every render; if `ChannelSidebar` is ever wrapped in `React.memo` the referential instability defeats the memo and re-renders all children.
  **Resolved** — module-level `EMPTY_CHANNELS` constant + `useMemo` — matches the post-7a9e99e pattern used throughout the rest of the codebase.
- [x] **[BUG] `AuditTab` loaded all entries in a single unbounded fetch.** `apps/web/src/components/moderation/AuditTab.tsx:22`. No `limit` query param, no virtualization. For an active server, hundreds of `<AuditRow>` nodes rendered at once.
  **Resolved** — `?limit=200` cap at the call site. Per-row virtualization is a deferred larger change; the cap keeps the UI snappy in the meantime.
- [x] **[BUG] `ReportsTab.refresh` was redefined every render, hidden behind an `eslint-disable`.** `apps/web/src/components/moderation/ReportsTab.tsx:48`. Reusing the component for a different `serverId` without unmounting showed stale data until manual refresh.
  **Resolved** — wrapped in `useCallback` with `[serverId]` dep; effect now lists `[refresh]` cleanly with no eslint suppression.
- [x] **[STYLE] `livekit-server` image pinned to `:latest`.** `infra/docker/docker-compose.yml:232`. Every other image in the compose file is pinned (postgres:16-alpine, redis:7-alpine, garage:v2.3.0, clamav:stable). A `docker pull` could pick up a breaking LiveKit release silently.
  **Resolved** — pinned to `livekit/livekit-server:v1.7.2`.
- [x] **[STYLE] No combined CI target in root `package.json`.** Each step (typecheck/lint/test/test:integration/build) was individually runnable, no single chain.
  **Resolved** — added `"ci": "pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build"` so CI configs can pin to one canonical script.

### Low / nits

- [x] **[DOC] `docs/permissions.md` table was missing `MANAGE_NICKNAMES` at bit 50.** Source defines `1n << 50n`; doc said "Bits 50–61 are reserved", contradicting `docs/api.md:75` which already referenced the flag.
  **Resolved** — added the row; updated "reserved" range to 51–61.
- [x] **[DOC] `docs/roadmap.md` IR20 federation entry read "no code yet"** — fossil from before Phases 1–6 shipped.
  **Resolved** — replaced with a "Shipped" block enumerating the six implemented phases plus an updated "Planned" block for Phases 7 (moderation) and 8 (voice).
- [x] **[DOC] `docs/federation-operations.md:33` stale paragraph claimed per-Tavern and per-channel federation opt-in settings "do not exist yet"** — they shipped with Phase 3.
  **Resolved** — paragraph rewritten to reference `Server.federationEnabled` and `Channel.federationMode` plus the `dms` / `presence` capability gating.
- [x] **[DOC] `docs/federation.md` "Open design questions" section was stale** — banner says all 7 locked, body still framed as active questions to resolve.
  **Resolved** — renamed to "Design decisions (locked)" and reframed as historical record.
- [x] **[DOC] `CLAUDE.md` layout block omitted `packages/federation`** — package has existed since Phase 1 of the federation work.
  **Resolved** — added to the layout tree and added `federation.md` / `federation-operations.md` / `federation-followups.md` to the "Other docs" list.
- [x] **[DOC] `README.md` layout omitted `packages/media` and `packages/federation`.**
  **Resolved** — both added with one-line summaries matching CLAUDE.md.
- [x] **[DOC] `.env.example` was missing `FEDERATION_ENABLED`, `FEDERATION_PRESENCE_ENABLED`, `TAVERN_DATA_KEY`.**
  **Resolved** — added a "Federation (OPTIONAL)" section at the end with documented defaults, a key-generation one-liner for `TAVERN_DATA_KEY`, and the multi-replica requirement for the worker.
- [x] **[DOC] `packages/federation/src/canonical-json.ts` lacked a JSDoc warning about `undefined` handling.** Subtle contract: `undefined` inside arrays → `null` (line 31), `undefined` as object property → omitted (line 35). Build envelopes with `null` for optional fields, not `undefined`, or the signature won't verify on the peer.
  **Resolved** — expanded the file-header doc with an explicit "Subtle contract for callers" section.

### Deferred (with rationale)

- **[SEC] LiveKit `devkey: devsecret-change-me` shipped in `infra/livekit/livekit.yaml`.** The agent flagged this CRITICAL but it is a deliberate, documented design choice: the `pnpm docker:up:full` workflow ships `NODE_ENV=production` even for local dev and uses these as the *intended* values out of the box. The API logs a loud `error` warning in production when the keys match the placeholder (`apps/api/src/app.ts:244–266`). Crashing on startup would break the canonical local-up workflow. **Mitigation already in place; documented in the file header and the production-hardening doc.** A future `scripts/livekit-config.mjs` parallel to `garage-config.mjs` could rotate at install time without changing the warn-don't-crash posture.
- **[BUG/SEC] Cross-peer envelope origin spoofing.** `federation-inbound.ts:326`. The envelope's signed origin (`fromInstance`) is verified against the `RemoteInstance` key, but the HTTP layer doesn't bind the request to the peer's TLS identity. A peer can deliver an envelope claiming a different origin (the signature catches forgery but a third-party-issued cert won't). Fix needs a design pass: either bind to client-cert SNI at the reverse proxy and pass through, or check `fromInstance` resolves to the request's TLS identity. **Deferred** — architectural, not safe inline.
- **[BUG/SEC] Key rotation: `previousInstanceKey` has no expiry / sweep.** `schema.prisma:2409`. Adding `previousInstanceKeyExpiresAt` + sweep + writing it at peering-accept is a schema migration plus dispatcher change; needs to be designed alongside the operational policy for rotation cadence. **Deferred.**
- **[BUG] Outbox FIFO is not per-peer.** `apps/worker/src/federation-outbox-worker.ts:34`. `concurrency: 4` across all peers, so reaction/edit/delete events for a message can be dispatched before the message-create that retried. The receiver permanently fails the dependent event (404 → `UnrecoverableError`). Fix is one of: per-peer Queue (lots of moving parts), serial concurrency (throughput hit), or 404-as-retry-eligible on the receiver. **Deferred** — design call.
- **[BUG] `dm.create` 403 from peer is treated as permanent `DM_CHANNEL_FEDERATION_REFUSED`.** A peer rolling-restart that drops the `dms` capability briefly produces a false "refused" notification. Fix is dispatcher-level (distinguish capability-removal 403 from genuine refusal) and needs careful test coverage. **Deferred.**
- **[BUG] Soft-deleted local users don't federate as `member.leave`.** Account-deletion worker doesn't enqueue federation events; peers keep zombie `ServerMember` rows. Symmetric inbound case is handled. Fix needs to coordinate with the deletion worker schedule and the rollback semantics on partial federation failure. **Deferred.**
- **[BUG] Remote-user zombie cleanup.** No sweep removes `RemoteUser` / synthetic `User` rows once a peer is revoked and the user has no remaining server/DM membership. **Deferred** — collision risk with ULIDs is vanishingly small; the storage bloat is the real concern but at federation scales this is months/years out.
- **[SEC] `/metrics` is unauthenticated.** `apps/api/src/plugins/metrics.ts:37`. Comment defers to reverse-proxy ACL but the default Docker compose doesn't enforce one. Fix needs a new env var (`METRICS_TOKEN`) and a token check — careful API design call. **Deferred.**
- **[SEC] OIDC `state` is not bound to the originating session/UA.** `oidc-service.ts:131`. PKCE is the right long-term answer (called out in the file header as a deferred follow-up). Interim session-cookie binding adds moving parts; PKCE work will subsume it. **Deferred to the PKCE follow-up.**
- **[SEC] WebAuthn `finishAuthentication` doesn't atomically claim the challenge.** `webauthn-service.ts:307`. Two concurrent finishes of the same challenge can both succeed (both mint sessions). Fix requires an atomic `take()` on the EphemeralStore (currently get + delete are two operations). **Deferred** — needs an EphemeralStore API change and a careful audit of the Redis vs in-memory backends.
- **[SEC] `LIVEKIT_API_SECRET` placeholder check logs error but doesn't refuse to start.** Same posture as the LiveKit YAML — documented design choice. The codebase already throws on insecure defaults for `TAVERN_DATA_KEY` (when `FEDERATION_ENABLED=true`); LiveKit is intentionally softer because the local-dev path uses the placeholder by design. **Deferred.**
- **[?] No worker healthcheck in docker-compose.** Designing the check itself (Redis ping? File heartbeat? Exposed HTTP endpoint?) is non-trivial for a worker that has no HTTP server. **Deferred** — see Track F note for proposals.
- **[STYLE] `federation-inbound.ts` at 4,362 lines.** Splittable along handler-type seams (messages, reactions, members, presence, dms, mirror) but the refactor is large and risky. **Deferred** — flagged for a dedicated PR.
- **[STYLE] `eslint.config.mjs` doesn't enable `@typescript-eslint/no-floating-promises`.** Rule requires `parserOptions.project` (type-aware linting), which isn't currently configured. **Deferred** — needs a build-config sweep, separate concern.
- **[?] `OIDC_AUTO_LINK_BY_EMAIL` defaults to `true`.** Compat-breaking to flip. Already documented in `.env.example` and `production-hardening.md` with the multi-IdP recommendation. **Deferred.**
- **[STYLE] `tsconfig.base.json` `skipLibCheck: true` lacks rationale comment.** Cosmetic; defer to a wider config-doc sweep.
- **Track I doc-drift items not addressed:** `docs/api.md` enumeration of ~60 missing routes (would be a substantial PR on its own); `docs/design-system.html` token-name vs CLAUDE.md mismatch (the HTML uses CSS variable names like `fg-default`, CLAUDE.md uses Tailwind utility names like `text-fg` — both are correct, not a real drift).

## Pass 2 verification

After applying every "Resolved" fix:

- `pnpm typecheck` — clean across 8 workspaces.
- `pnpm lint` — clean across 8 workspaces (the one `react-hooks/exhaustive-deps` warning on VoiceRoom's intentionally-narrowed deps got an explicit `eslint-disable-next-line` with rationale).
- `pnpm test` — **396 tests pass** (apps/api 172, packages/shared 205, packages/federation 10, apps/worker 5, apps/web 4). Same Redis ECONNREFUSED noise as Pass 1; same in-memory fallback explanation.
- `pnpm test:integration` — **408 of 413 pass.** 5 failures are pre-existing and **not introduced by Pass 2** (verified by `git stash` + re-running on the unmodified baseline). Four (`message.update`, `message.delete`, `dm.message.update`, `dm.message.delete` happy-path tests) use hardcoded fixture timestamps from `2026-05-19/20`; the system date has advanced past the `MAX_CLOCK_SKEW_MS` (5 min) window added in commit 0a0d89e, so the fixtures are now outside the skew window. The fifth (`federation-two-instance` "peering status routes correctly") fails with `expected 'pending_inbound' got 'peered'` — looks like the two-instance harness has a timing/state-leak issue that needs separate investigation. Both classes of failure pre-exist Pass 2.
- `pnpm build` — clean across 8 workspaces. Pre-existing chunking and large-bundle warnings unchanged.

## Pass 2 file scope

36 files modified, +658/-113 lines. By area:

- **apps/api**: `config.ts`, `routes/{invites,reactions,voice}.ts`, `services/{federation-inbound,plugin-loader}.ts`
- **apps/worker**: `config.ts`, `src/index.ts` (heavy)
- **apps/web**: `lib/inbox-store.ts`, `routes/{admin-federation-page,app-shell}.tsx`, `components/{FederatedInvitePreviewModal,LiveCaptions,MessageComposer,RecordingControls,ServerInvitesPanel,VoiceRoom,WatchPartyPanel}.tsx`, `components/moderation/{AuditTab,ReportsTab}.tsx`, `public/sw.js`, `nginx.conf`
- **packages**: `shared/src/dice/template.ts`, `federation/src/canonical-json.ts`, `media/src/scanner.ts`, `media/src/storage/local.ts`, `db/prisma/schema.prisma`, `db/prisma/migrations/20260523200000_user_remote_instance_index/migration.sql` (new)
- **infra**: `docker/docker-compose.yml`
- **docs**: `permissions.md`, `roadmap.md`, `federation.md`, `federation-operations.md`, `README.md`, `CLAUDE.md`, `.env.example`
- **root**: `package.json` (CI script)
