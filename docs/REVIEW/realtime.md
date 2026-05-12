# Realtime Gateway & Voice Review

## Summary

The gateway handshake, permission model, and LiveKit token-grant pipeline are well-structured and largely correct. The biggest systemic risks are: (1) a missing per-channel permission re-check on VOICE_STATE_UPDATE fanout that can surface hidden-channel presence data to members who lost VIEW_CHANNEL; (2) fire-and-forget WebSocket writes with no backpressure or slow-consumer eviction; (3) a silent drop of malformed Redis messages that makes diagnosing payload-serialisation bugs in multi-replica deployments unnecessarily hard; and (4) a startup-ordering bug in LazyBroker that causes all gateway events to be dropped in Redis mode. Several HIGH issues (missing leave() timer clear, N+1 permission queries in fanout, missing LiveKit token refresh) are also worth resolving before a production deployment.

---

## Critical Findings

### [RT-001] VOICE_STATE_UPDATE fanout uses server-level membership, not channel-level VIEW_CHANNEL

- **Severity:** CRITICAL
- **File:** `apps/api/src/gateway/index.ts:274-303`
- **Issue:** `shouldDeliver` for `serverId`-scoped events (which `VOICE_STATE_UPDATE` always is, per `voice.ts:147-151`) only checks that the recipient is a server member. It never calls `getChannelPermissions`. A member whose `VIEW_CHANNEL` bit was removed via a per-channel deny overwrite still receives the full voice-state payload including `channelId`, `screenSharing`, `cameraOn`, and `selfMute` for every user in that channel.
- **Impact:** Privacy leak. Members who should not know a private channel exists receive real-time presence for that channel via VOICE_STATE_UPDATE events.
- **Repro:** Create a private voice channel with a deny-VIEW_CHANNEL overwrite for role A. Connect two clients: one with role A (restricted) and one in the private channel. When the in-channel user toggles mute, the restricted client WebSocket receives the VOICE_STATE_UPDATE payload containing channelId, mute state, and camera/screen flags.
- **Fix:** When the event carries both `serverId` and a non-null `channelId` in `data`, call `getChannelPermissions(data.channelId, userId)` and require `VIEW_CHANNEL` before delivering. Extend `shouldDeliver` to accept an optional `dataChannelId` parameter extracted from the typed event payload.

---

## High Findings

### [RT-002] socket.send() is fire-and-forget with no backpressure or slow-consumer eviction

- **Severity:** HIGH
- **File:** `apps/api/src/gateway/index.ts:226-233`
- **Issue:** `sendRaw` calls `client.ws.send()` without checking `socket.bufferedAmount` or the underlying stream writability. For a slow or temporarily disconnected client the OS send-buffer grows unboundedly until the OS drops the socket or the process OOMs.
- **Impact:** Memory exhaustion or server crash on a sustained slow consumer.
- **Fix:** Gate sends on `socket.bufferedAmount` against a threshold (e.g. 256 KB). Close exceeding clients with code 1008 after a warning log. The heartbeat sweeper is the natural enforcement point alongside the existing timeout check.

### [RT-003] 256-event buffer overflow: no INVALID_SESSION signal and no log entry

- **Severity:** HIGH
- **File:** `apps/api/src/gateway/index.ts:243-245`
- **Issue:** When the buffer is full, `client.buffer.shift()` silently drops the oldest event with no log and no INVALID_SESSION signal to the client.
- **Impact:** High-traffic channels silently drop events for lagging clients; the client cannot distinguish a successful resume from a missed-event scenario.
- **Fix:** (1) Log at `warn` level on overflow, including `clientId` and `userId`. (2) Send `INVALID_SESSION` immediately on overflow so the client performs a clean re-IDENTIFY.

### [RT-004] Redis malformed-message silent drop with no log or dead-letter path

- **Severity:** HIGH
- **File:** `apps/api/src/services/gateway-broker.ts:69-77`
- **Issue:** The `subscriber.on("message")` handler catches `JSON.parse` failures entirely silently. In a multi-replica deployment, a peer process serialising events incorrectly produces messages discarded with no log, no metric, and no dead-letter. Operators cannot distinguish a quiet Redis channel from one delivering corrupt messages.
- **Impact:** Loss of real-time events in production with zero observability.
- **Fix:** At minimum log at `error` level including a truncated raw payload. Optionally push to a dead-letter list (`LPUSH tavern:gateway:dlq`) for post-mortem analysis.

### [RT-005] Fanout issues one getChannelPermissions DB query per client per event (N+1)

- **Severity:** HIGH
- **File:** `apps/api/src/gateway/index.ts:217-224`
- **Issue:** For a `channelId`-scoped event delivered to N connected clients, `shouldDeliver` runs `getChannelPermissions(channelId, userId)` per client, executing at least 4 sequential Prisma queries per call. On a server with 100 connected members this is 400 DB round-trips per message event.
- **Impact:** At realistic community scale this serialises the event loop and adds seconds of delivery latency, effectively a self-inflicted DoS.
- **Fix:** Either (a) a permission cache (TTL ~30 s) keyed by `(channelId, userId)`, or (b) batch: load all member IDs with VIEW_CHANNEL on the target channel once per event and intersect with the connected-client set.

### [RT-006] LazyBroker.useRedis loses all subscriptions registered before promotion

- **Severity:** HIGH
- **File:** `apps/api/src/services/gateway-broker.ts:111-129`
- **Issue:** `useRedis` closes the `InProcessBroker` (calling `emitter.removeAllListeners()`), then swaps `this.inner` to the `RedisBroker`. Any handlers registered via `subscribe()` before `useRedis()` subscribed to the `InProcessBroker` emitter and are now orphaned. The gateway fanout handler registered at startup is therefore never called for Redis-delivered events.
- **Impact:** In a multi-replica Redis deployment the gateway silently stops delivering events produced by peer processes. Total realtime blackout for cross-process events.
- **Fix:** `LazyBroker` must keep its own handler list and re-register each handler against the new inner broker before closing the old one. Alternatively enforce that `useRedis()` is called before any `subscribe()` at startup and document this as a hard constraint.

### [RT-007] Missing stateTimer clear in leave() allows a deferred state POST to race the leave

- **Severity:** HIGH
- **File:** `apps/web/src/components/VoiceRoom.tsx:263-266`
- **Issue:** `leave()` does not clear `stateTimer.current` before calling `room.disconnect()`. A pending 200 ms debounce timer fires after leave and sends `POST /voice/state` with the now-vacated `channelId`. The server rejects with 409, but if the state POST wins the race before leave completes, the user record is briefly left with a non-null `channelId`.
- **Fix:** Clear `stateTimer.current` at the top of `leave()`, mirroring what the join `useEffect` cleanup already does.

### [RT-008] /voice/leave has no rate limit and uses an N+1 update pattern

- **Severity:** HIGH
- **File:** `apps/api/src/routes/voice.ts:170-192`
- **Issue:** (a) The route has no `rateLimit` config, unlike `/voice/state` (60/min). A crash-looping client hammers it unconstrained. (b) It fetches all `VoiceState` rows then issues a separate `prisma.voiceState.update` per row in a for loop instead of a single `updateMany`.
- **Fix:** Add `config: { rateLimit: { max: 30, timeWindow: "1 minute" } }`. Replace the loop with `prisma.voiceState.updateMany`; keep the `findMany` result for per-row broker events.

### [VC-001] LiveKit token TTL is 1 hour with no client-side refresh path

- **Severity:** HIGH
- **File:** `apps/api/src/routes/voice.ts:97` and `apps/api/src/services/livekit-token.ts:40`
- **Issue:** Token minted with `ttlSeconds: 60 * 60`. LiveKit refuses to reconnect a participant whose token has expired. The component sends `expiresAt` to the client but never inspects it and does not pass a `tokenProvider` to the `Room` constructor.
- **Impact:** Users in a voice room for more than 1 hour are silently disconnected by LiveKit on the next reconnect attempt, with no warning shown.
- **Fix:** Pass a `tokenProvider` callback to `new Room()` that calls `/voice/join` to mint a fresh token. Alternatively, surface an expiry warning based on `expiresAt`.

### [VC-002] VOICE_STATE_UPDATE fanout bypasses channel VIEW_CHANNEL check (structural gap)

- **Severity:** HIGH
- **File:** `apps/api/src/routes/voice.ts:222-224` (cross-references RT-001)
- **Issue:** `/voice/state` re-checks `STREAM_SCREEN` and `ENABLE_CAMERA` before writing to the DB. However the fanout path in `shouldDeliver` does not re-check `VIEW_CHANNEL` for the `channelId` embedded in the payload. Any future broadcast path that bypasses `/voice/state` would skip the visibility check entirely.
- **Fix:** Consolidate the defence in `shouldDeliver` by gating on the `channelId` in `event.data` (see RT-001 fix). Do not rely on call-site discipline.

### [RT-009] Same user connecting from two tabs produces divergent voice state on tab close

- **Severity:** HIGH
- **File:** `apps/api/src/gateway/index.ts:168-183`
- **Issue:** Both tabs complete IDENTIFY and both receive fanout events. If tab 2 joins a voice channel, both tabs display the user as in the room, but only tab 2 has a LiveKit room. When tab 1 closes, no voice-state cleanup occurs for tab 2.
- **Impact:** Stale voice-state display on multi-tab usage; DB state divergence that resolves only on explicit leave or reconnect.
- **Fix:** Link `VoiceState` rows to a `sessionId` so a disconnect from one session does not clobber another. At minimum document the multi-session constraint and add a test.

---

## Medium Findings

### [RT-010] RESUME always re-READYs without replaying buffer; unknown sessionId not rejected

- **Severity:** MEDIUM
- **File:** `apps/api/src/gateway/index.ts:185-204`
- **Issue:** The RESUME handler ignores whether `r.sessionId` matches any known session and always re-sends READY without replaying buffered events. A fabricated sessionId gets a successful READY indistinguishable from a real resume. The client has no signal that a gap occurred.
- **Fix:** Document this Phase 1 limitation. If `r.sessionId` does not match the client own `id`, send `INVALID_SESSION` so the client takes the re-IDENTIFY branch.

### [RT-011] Heartbeat sweeper skips pre-identified clients; single timer guards IDENTIFY enforcement

- **Severity:** MEDIUM
- **File:** `apps/api/src/gateway/index.ts:67-79`
- **Issue:** The sweeper skips `!c.identified` clients. A client that connects and stays open without identifying avoids the heartbeat timeout. The `identifyTimer` (10 s) is the only guard; if it misfires the connection leaks permanently.
- **Fix:** Add a secondary check: if the client is unidentified and the connection age exceeds `IDENTIFY_TIMEOUT_MS * 2`, close it.

### [RT-012] console.warn in LazyBroker.useRedis bypasses the structured app logger

- **Severity:** MEDIUM
- **File:** `apps/api/src/services/gateway-broker.ts:127`
- **Issue:** The Redis fallback warning uses bare `console.warn`, bypassing the Fastify/Pino JSON structured logger. In production this message will not appear in log pipelines with correlation metadata.
- **Fix:** Accept a `pino.Logger` parameter in `initRedisBroker` and replace `console.warn` with `logger.warn`.

### [VC-003] Typing indicator shows raw user ID prefix instead of display name

- **Severity:** MEDIUM
- **File:** `apps/web/src/components/TypingIndicator.tsx:29-33`
- **Issue:** The label renders `others[0]!.slice(0, 8)` (a raw ULID prefix) because the TYPING_START gateway payload carries only `{ channelId, userId }` and the store only records a timestamp.
- **Impact:** Users see "a1b2c3d4 is typing..." instead of a display name.
- **Fix:** Include `displayName` in the TYPING_START payload and store it alongside the timestamp, or resolve the userId against the member list already in the store.

### [VC-004] Stale typing indicator persists for up to 9 seconds after tab close

- **Severity:** MEDIUM
- **File:** `apps/web/src/components/MessageComposer.tsx:82-88`
- **Issue:** Typing pings fire at most once per 3 s; the client-side TTL is 6 s. If a user closes the tab mid-compose, others see the indicator for up to 9 s with no server-side TYPING_STOP event.
- **Fix:** Either emit TYPING_STOP from the gateway on socket close for recently-typing users, or reduce TYPING_TTL_MS to 5 s and the throttle interval to 2 s.

### [VC-005] toggleMic optimistically updates state before the LiveKit call completes

- **Severity:** MEDIUM
- **File:** `apps/web/src/components/VoiceRoom.tsx:205-211`
- **Issue:** `setMuted(next)` and `reportVoiceState` are called before `await room.localParticipant.setMicrophoneEnabled(!next)`. If that call throws, the displayed mute state and server-side state reflect the intended new value but the actual LiveKit track is unchanged.
- **Impact:** UI shows mic as muted but audio is still transmitting.
- **Fix:** Await the LiveKit call first, then update state. Or add a catch that reverts both `setMuted` and the server-side voice state.

### [VC-006] Brief empty-state flash on join: status set to connected before syncParticipants

- **Severity:** MEDIUM
- **File:** `apps/web/src/components/VoiceRoom.tsx:183-186`
- **Issue:** `setStatus("connected")` (line 185) is called before `syncParticipants(r)` (line 186). Between those two statements the component renders with `status === "connected"` and an empty participants array, flashing "Just you for now." before the local participant tile appears.
- **Fix:** Call `syncParticipants(r)` before `setStatus("connected")`.

---

## Low Findings

### [RT-013] HELLO sessionId received by client but never stored for future RESUME

- **Severity:** LOW
- **File:** `apps/web/src/lib/gateway-client.ts:90-94`
- **Issue:** The HELLO `sessionId` is destructured but discarded. A future RESUME implementation would have no stored value to send.
- **Fix:** Store `d.sessionId` in a private field.

### [RT-014] Missed HEARTBEAT_ACK not detected; zombie-server scenario possible

- **Severity:** LOW
- **File:** `apps/web/src/lib/gateway-client.ts:96`
- **Issue:** There is no tracking of last-ack vs last-beat time. A server that stops ACKing is not detected until the TCP connection drops.
- **Fix:** Record `lastAckAt = Date.now()` on ACK. Before each heartbeat, close and reconnect if no ACK was received since the last beat.

### [RT-015] Reconnect backoff applies no jitter, causing thundering-herd on server restart

- **Severity:** LOW
- **File:** `apps/web/src/lib/gateway-client.ts:73-78`
- **Issue:** All simultaneously-disconnected clients reconnect after exactly the same computed delay.
- **Fix:** Apply jitter: `delay = delay * (0.5 + Math.random() * 0.5)`.

### [RT-016] sendRaw catch block silently swallows non-socket-gone errors

- **Severity:** LOW
- **File:** `apps/api/src/gateway/index.ts:226-233`
- **Issue:** Errors such as `RangeError: Invalid WebSocket frame` are swallowed without logging, making debugging harder.
- **Fix:** Log unexpected errors (excluding known closed-socket codes) at `debug` level.

### [RT-017] buildReadyPayload omits channels; requires additional REST fetch per server on connect

- **Severity:** LOW
- **File:** `apps/api/src/gateway/index.ts:253-272`
- **Issue:** READY contains servers but not channels. This is an intentional Phase 1 simplification but is undocumented, making it appear like an oversight.
- **Fix:** Document the constraint in `docs/architecture.md` as a known roadmap item.

### [VC-007] LiveKit Room does not configure a reconnect policy

- **Severity:** LOW
- **File:** `apps/web/src/components/VoiceRoom.tsx:114`
- **Issue:** `new Room({ adaptiveStream: true, dynacast: true })` uses the library default reconnect policy (3 attempts). This may be insufficient on flaky mobile networks.
- **Fix:** Pass `reconnectPolicy: { maxRetries: 10, retryDelayMs: 2000 }` and document the chosen values.

### [VC-008] ScreenShareSettingsPopover onChange not guarded against disabled-state bypass

- **Severity:** LOW
- **File:** `apps/web/src/components/ScreenShareSettingsPopover.tsx:18`
- **Issue:** The trigger button is disabled when `screenOn` is true, but the underlying `onChange` callbacks have no runtime guard. An accessibility tool or automation that bypasses the button can invoke `setShareOptions` mid-share.
- **Fix:** Add `if (disabled) return` in the `onChange` handlers.

### [VC-009] Local JoinResponse interface duplicates the shared voiceJoinResponseSchema

- **Severity:** LOW
- **File:** `apps/web/src/components/VoiceRoom.tsx:27-38`
- **Issue:** A hand-rolled `JoinResponse` interface mirrors `voiceJoinResponseSchema`. A future schema change could silently diverge.
- **Fix:** Replace with `import type { VoiceJoinResponse } from "@tavern/shared"` and use `voiceJoinResponseSchema.parse(joinRes)` on the response.

### [VC-010] LiveKit token nbf clock-skew offset is an unexplained magic number

- **Severity:** LOW
- **File:** `apps/api/src/services/livekit-token.ts:47`
- **Issue:** `nbf: Math.floor(Date.now() / 1000) - 5` subtracts 5 without explanation.
- **Fix:** `const CLOCK_SKEW_TOLERANCE_S = 5;` used in the expression.

### [RT-018] INVALID_SESSION handler re-identifies in-place rather than reconnecting cleanly

- **Severity:** LOW
- **File:** `apps/web/src/lib/gateway-client.ts:98-101`
- **Issue:** On `INVALID_SESSION`, `identify()` is called on the existing socket without restarting the heartbeat or clearing the old interval. If the server ever sends a new HELLO in response, `startHeartbeat` would be called twice, duplicating the interval.
- **Fix:** On `INVALID_SESSION`, close the socket and let the close handler trigger a fresh reconnect and HELLO exchange.

---

## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1     | block  |
| HIGH     | 9     | warn   |
| MEDIUM   | 6     | info   |
| LOW      | 8     | note   |

**Verdict: BLOCK** - RT-001 (channel presence leak to non-VIEW_CHANNEL members) must be fixed before shipping. RT-006 (LazyBroker subscription loss) silently breaks all multi-replica Redis deployments and should be treated as critical for any scaled deployment. All HIGH items should be resolved before production.

---

## Positive Notes

- The IDENTIFY handshake validates not only the JWT signature but also the DB session row (`revokedAt`, `expiresAt`), ensuring revoked sessions are rejected even when the access token has not yet expired.
- `shouldDeliver` defaults to `false` for untargeted events (correct secure default).
- The `VoiceRoom` join effect correctly guards all `setState` calls with a `mounted` flag, preventing stale-state errors on fast navigation.
- `ScreenShareTile` `fullscreenchange` listener returns a proper cleanup function (`removeEventListener`), avoiding a common listener-leak anti-pattern.
- `voiceStatePayload()` passes each row through `voiceStateGatewayPayloadSchema.parse()` before broadcasting, surfacing schema drift loudly at the call site.
- Rate limiting on `/voice/state` (60 req/min) is present and correctly placed.
- `LazyBroker` degrades gracefully to in-process on Redis failure, keeping the server operational for single-replica deployments.
- The `stateBuffer`/`stateTimer` debounce in `VoiceRoom` correctly merges rapid partial state updates before POSTing, reducing chatty REST traffic.
- `/voice/state` re-validates `STREAM_SCREEN` and `ENABLE_CAMERA` permissions on every write, catching role demotions that occurred after token minting.
