# Track B — Web: State, Selectors, Realtime

## Critical / High

**[BUG] `app-shell.tsx:164` inline `?? []` on a store-derived value returned into JSX.** `apps/web/src/routes/app-shell.tsx:164`. `const channels = params.serverId ? (channelsByServer[params.serverId] ?? []) : [];` — `channelsByServer` is subscribed via `useRealtime` on line 51 and is stable; the `??` fallback is applied in render-body code, not inside a selector callback, so it does not directly trigger an infinite re-render. **However**, `channels` is passed as a prop to `ChannelSidebar` and iterated in the same render. Every time `channelsByServer` changes for *any* server but `params.serverId` has no entry, this expression evaluates to a new `[]` literal. MEDIUM today (extra renders), HIGH if `ChannelSidebar` is ever wrapped in `React.memo`. Fix: module-level `EMPTY_CHANNELS` constant + `useMemo`.

**[BUG] Inbox-store race: `hydrateReadStates` vs `MENTION_CREATE` can double-count mention badge.** `apps/web/src/lib/inbox-store.ts` / `apps/web/src/lib/realtime.ts:76`. `startRealtime` fires `hydrateReadStates()` (a `void` async call) immediately after `client.connect()`. The gateway begins receiving events the moment the WebSocket opens, and `MENTION_CREATE` can arrive while the HTTP request is still in flight. When the HTTP response lands it calls `set({ readStatesByChannel: byChannel, … })`, which **replaces** the entire map, discarding any mentions that arrived via `onMentionCreate` between call start and resolution. Fix: merge HTTP snapshot into existing map and take per-channel max.

**[BUG] `applyReaction` is not idempotent for duplicate broker fan-out.** `apps/web/src/lib/store.ts:357`. REACTION_ADD is guarded for viewer double-apply but not for non-viewer duplicates. If two copies of the same `REACTION_ADD { userId: "alice" }` arrive (federation fan-out duplicate or WebSocket resume replaying), the count increments twice. REACTION_REMOVE has the same gap. Short of tracking per-user reaction membership in state, the wire layer must guarantee at-most-once delivery — document the assumption.

## Medium

**[PERF] `customStatus` expiry check is recomputed on every render, not memoised.** `apps/web/src/components/MemberProfileCard.tsx:48,147`. `isExpired(effectiveCustomStatusExpiresAt)` calls `Date.now()` on every render. Also, no periodic tick forces a re-render at the expiry moment — the pill can linger until the parent re-renders.

**Voice two-pass:** correctly implemented in `store.ts:712`. `applyVoiceState` evicts + places inside a single `set()` call. No flicker.

**[PERF] `TypingIndicator` double re-renders per tick.** `apps/web/src/components/TypingIndicator.tsx:17`. `setInterval` calls both `expire(channelId, ...)` (Zustand `set()`) and `force(n => n + 1)` (local re-render). Removing `force(n => n + 1)` and relying solely on the store subscription would halve the render rate.

**[?] No backoff reset guard after prolonged disconnect.** `apps/web/src/lib/gateway-client.ts:162`. `INVALID_SESSION` triggers an immediate re-IDENTIFY (no scheduleReconnect call), so the backoff is never engaged for that error path. Identify → INVALID_SESSION loop runs at network speed.

**[BUG] `ackMention` does two separate `set()` calls that can interleave.** `apps/web/src/lib/inbox-store.ts:127`. First updates `readStatesByChannel` + `inboxItems`, then second recomputes `totalUnreadMentions`. A gateway MENTION_CREATE between the two calls causes the second `set` to compute totals from the post-event map. Fold both into a single `set` callback (`ackChannel` and `ackAllMentions` already do this correctly).

## Low / Nits

**[STYLE] `MemberProfileCard` reads `Date.now()` inside `isExpired` at component render time.** Not an issue now (pure client), but a hydration mismatch risk if ever rendered on a server.

**[STYLE] `captions-store.ts:66` installs a `setInterval` at module-evaluation time** with no exported teardown handle. Fine for SPA, but a HMR leak in dev.

**[DOC] `customStatusByUserId` comment in `store.ts:126` says "consumers compare against `Date.now()` on each render"** but omits that there is no mechanism to force a re-render at the expiry boundary.

## Notes

- Selector stability post-7a9e99e: pattern is applied correctly in `MessageList`, `DmMessageList`, `TypingIndicator`, `MemberSidebar`, `VoiceRoom`, `server-home.tsx`. Only survivor is `app-shell.tsx:164`.
- Gateway-client reconnect re-entrancy: Pass 1 double-socket fix sticks. `connect()` early-out on line 40 guards `'connecting'` and `'reconnecting'`; `close()` clears `resumeSessionId` and resets `lastSeq`.
- Optimistic UI: composer sends a `nonce` but does **not** insert an optimistic message. Server's `MESSAGE_CREATE` is the first time it appears — no optimistic-vs-server reconciliation problem.
- Idempotency of handlers other than reactions: MESSAGE_CREATE/UPDATE/DELETE, VOICE_STATE_UPDATE, PRESENCE_UPDATE, MEMBER_UPDATE all idempotent (last-write-wins or find-by-id).
