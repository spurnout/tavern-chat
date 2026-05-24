# Track E — API: Routes, Services, Auth, Gateway

## Critical / High

**[SEC] Invite `maxUses` race in local join path — optimistic check-then-increment, no row lock.** `apps/api/src/routes/invites.ts:280-302`. `/api/invites/:code/join` reads `invite.uses` and `invite.maxUses` in a plain `findUnique`, then issues a separate `prisma.invite.update { uses: { increment: 1 } }` with no conditional predicate and no transaction. N concurrent requests can all pass the `uses >= maxUses` guard and all increment — producing `maxUses + (N-1)` successful joins on a `maxUses=1` invite. The registration path in `auth-service.ts` correctly uses a conditional `updateMany` with `uses: { lt: maxUses }` predicate inside a transaction. Fix: same pattern in the invite-join route.

**[SEC] `/metrics` is unauthenticated and exposes user/server/session counts.** `apps/api/src/plugins/metrics.ts:37`. Comment says "restrict at reverse-proxy layer" — but endpoint emits live `prisma.user.count()`, `prisma.server.count()`, `prisma.session.count({ where: { revokedAt: null } })` on every scrape with no auth. On the default single-process Docker setup there is no guarantee the reverse proxy covers the API port directly. Add optional `METRICS_TOKEN` env var.

**[SEC] OIDC `state` parameter has no binding to user-agent/IP/session.** `apps/api/src/services/oidc-service.ts:131-144`. `state` is opaque/unpredictable. Nothing binds it to the browser session that initiated the flow, so if an attacker can steal the `state` value (referrer leak, open redirect at IdP) they can complete the callback in their browser and hijack the session. PKCE acknowledged as deferred follow-up. Interim: store originating session cookie/fingerprint in `PendingState` and check on callback.

**[PERF/BUG] Custom-status expiry is never swept — stale statuses persist indefinitely.** `apps/api/src/services/presence-service.ts`, callers. `customStatusExpiresAt` exists and is checked on user refresh, but no server-side cron clears expired. User who sets "in 30 min" then goes offline shows expired status until they next interact. Fix: periodic `updateMany({ where: { customStatusExpiresAt: { lt: now } }, data: { customStatus: null, customStatusExpiresAt: null } })`.

**[BUG] Voice channel-switch race — no leave fanout for previous channel.** `apps/api/src/routes/voice.ts:173-198`. `voiceState.upsert` atomically moves the row to channel B. Stale-flag cleanup `updateMany` (line 160) runs *before* upsert without txn. `VOICE_STATE_UPDATE` fanout for old channel is NOT emitted — other clients in channel A never see the user leave. User appears in both channels in any client computing membership from pre-join state. Emit leave for `previousChannelId` (if different) atomically with join.

## Medium

**[BUG] Reaction DELETE silently swallows all errors, not just missing-row.** `apps/api/src/routes/reactions.ts:300-305`. Bare `catch { /* idempotent */ }` absorbs any DB error including connection failures. Federation fan-out then fires for a reaction that was not actually removed. Narrow to `P2025` only.

**[BUG] Federation fan-out for message create is after-commit, not transactional.** `apps/api/src/routes/messages.ts:497-532`. Message committed at line 402, federation enqueue at line 504. Crash between commit and enqueue → event permanently lost. Documented trade-off in comment, but worth a known-data-loss-window note.

**[BUG/SEC] `quick-reactions` endpoint permission check is effectively disabled.** `apps/api/src/routes/reactions.ts:93-97`. `requireChannelPermission` wrapped in `.catch(() => undefined)`. User with no VIEW_CHANNEL permission can still enumerate emoji used server-wide. Endpoint is keyed by `serverId` — correct guard is `requireServerPermission(serverId, ctx.userId, Permission.VIEW_CHANNEL)` or membership check.

**[SEC] Plugin loader hook has no timeout — slow plugin stalls all fanout callers.** `apps/api/src/services/plugin-loader.ts:140-165`. `dispatchHook` is `await Promise.allSettled` with no per-plugin timeout. Hung plugin blocks the route handler. Wrap with `Promise.race([fn(...), timeout(HOOK_TIMEOUT_MS)])`.

**[BUG] WebAuthn `finishAuthentication` does not delete challenge before counter update.** `apps/api/src/services/webauthn-service.ts:307-323`. Challenge deleted in `finally` (line 307), counter update runs after. Two concurrent auth flows for same user with same challenge key could both succeed and both bump the counter. Delete challenge as first step in critical section.

**[SEC] `OIDC_AUTO_LINK_BY_EMAIL` defaults to `true`.** `apps/api/src/config.ts:222`. Documented as account-takeover-shaped for multi-IdP. Production guidance should call this out explicitly. At minimum, NODE_ENV=production log-level-error warning when `OIDC_AUTO_LINK_BY_EMAIL=true` AND `OIDC_ISSUER_URL` is configured.

**[SEC] `LIVEKIT_API_SECRET` default-value check logs at `error` but does not refuse to start.** `apps/api/src/app.ts:244-265`. LiveKit and LIVEKIT_URL insecure-default warnings use `app.log.error` instead of throwing. Operator who misses the log line runs a public instance where anyone can self-sign LiveKit room tokens. Upgrade to `throw new Error(...)` startup refusal.

## Low / Nits

**[DOC] `plugin-loader.ts:19` says "no VM sandbox"** but `listLoadedPlugins()` returns `manifest.entry` (filesystem path relative to plugin dir). Low severity (admin-only endpoint).

**[STYLE] `dispatchHook` per-plugin try/catch redundant with `Promise.allSettled`** (still useful for per-hook logging, just worth a comment).

**[DOC] `STAGED_TOTP_SECRET` has no production-startup refusal.** `apps/api/src/config.ts:31`. Silent fallback derivation; should match the posture of `JWT_ACCESS_SECRET` validation.

## Notes

- **Admin gate uniformity.** All `/api/admin/*` routes check `ctx.isInstanceAdmin` and throw `TavernError.forbidden()`. No admin route missing a guard. Clean.
- **Soft-delete filtering.** All `prisma.message.findMany` calls in reviewed routes include `deletedAt: null`. DM message listing at `dms.ts:323` correctly filters. No missing filter found in reviewed paths.
- **Voice state race.** `VoiceState` uses `@@unique([serverId, userId])` — user cannot appear in two channels in the DB. Gap is the missing leave-fanout (above).
- **Reaction idempotency.** PUT uses upsert with composite unique `messageId_userId_emoji`. Concurrent add+remove: delete catches `P2025`; concurrent add+add: upsert handles `P2002`. Clean DB-level.
- **Gateway auth.** Token passed in IDENTIFY/RESUME message body (not URL), not leaked in access logs. Session validated server-side on every IDENTIFY/RESUME. Heartbeat sweep and slow-consumer eviction present. Broadcast scoping defaults to deny for untargeted events.
- **`listLoadedPlugins()`** returns manifest fields only, not `directory` absolute path. `entry` (relative) present.
