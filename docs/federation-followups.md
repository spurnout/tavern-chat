# Federation follow-ups

Living list of non-blocking work surfaced during federation rollout. Each item has a status, the phase that introduced it, and a rough trigger (when it must be resolved). Resolved items move to the bottom.

## Open

### 1. Key fingerprint in admin UI

- **Phase:** 1 (review)
- **Trigger:** before any public-internet deployment
- **What:** `docs/federation-operations.md` instructs operators to verify a peer's instance-key fingerprint out-of-band. `apps/web/src/components/admin/PeersTable.tsx` does not yet display one. Add a SHA-256 (truncated, hex) of `instanceKey` as a row column.

### 2. Per-route rate-limit tuning

- **Phase:** 1 (review)
- **Trigger:** before any public-internet deployment
- **What:** The global Fastify rate-limit (300 req/min/IP) is fine for user-facing routes but loose for the public, outbound-fetch-triggering `/_federation/peering` and `/.well-known/tavern-federation`. Add per-route limits (~10/min/IP) once Fastify rate-limit's per-route override is wired.

### 3. `FederationEnvelopeLog` retention sweep

- **Phase:** 1 (deferred to 3)
- **Trigger:** when Phase 3 worker queues land
- **What:** Schema has `(peerInstanceId, receivedAt)` index ready for time-based pruning. Need a BullMQ job that deletes rows older than 30 days. Folds naturally into Phase 3 because that's when the worker outbox + recurring-job infra arrives.

### 4. Replace `window.prompt` revoke-reason input

- **Phase:** 1 (review)
- **Trigger:** when other federation UI polish lands
- **What:** `apps/web/src/routes/admin-federation-page.tsx::revoke()` uses `window.prompt` for the optional reason. UX polish; replace with a styled confirm modal.

### 5. Docker-verified migration round-trip

- **Phase:** 1 (env constraint)
- **Trigger:** next time someone runs Postgres locally
- **What:** `packages/db/prisma/migrations/20260519120000_add_federation_peering/migration.sql` was hand-authored to match Prisma's generator format (Docker wasn't reachable from the implementer's sandbox). When Docker is available, run `pnpm --filter @tavern/db migrate:dev` against a clean DB and confirm Prisma emits byte-equivalent SQL.

### 6. `assertValidPeerHost` could be stricter

- **Phase:** 1 (review)
- **Trigger:** before public deployment if not earlier
- **What:** Current guard rejects bare IPv4, IPv6, `localhost`, and dotless hostnames. A best-effort DNS resolution check (rejects hosts resolving ONLY to private/loopback ranges) is already in place, and `*.local` (mDNS, RFC 6762) + `*.localhost` (RFC 6761) are now rejected synchronously (2026-05-29 — they otherwise NXDOMAIN past the DNS check and reach the LAN). **Remaining:** `*.internal` / other private-use TLDs, and DNS-rebinding/TOCTOU (the resolution check races the later fetch). Low severity given the private-IP DNS check.

### 7. Avatar URLs in federated profile responses

- **Phase:** 2 (P2-5)
- **Trigger:** before avatar federation is expected to actually work
- **What:** `FederationProfileService.deriveAvatarUrl` constructs `https://<selfHost>/api/attachments/<id>`. The current attachment route likely requires an authenticated session, so peers caching this URL will get 401 when fetching. For Phase 2 the URL is still emitted (downstream consumers tolerate `null`/broken images), but real avatar federation needs either a public media proxy, a signed/short-lived federation-scoped URL, or inlining the avatar bytes in the response envelope. Defer until the UX matters.

### 8. Profile preview UX — richer hover card

- **Phase:** 2 (P2 wrap-up)
- **Trigger:** if/when `profile.response` gains additional fields
- **What:** The Phase 2 hover card shows display name, home instance, and last-seen time.
  If `FederationProfileService` is extended to include presence, pronouns, or bio,
  the `RemoteUserHoverCard` component should surface them. Not urgent — defer until
  those fields are added to the profile envelope schema.

### 10. Mention-parser deduplication (server vs. web)

- **Phase:** 2 (P2 wrap-up)
- **Trigger:** any time the qualified-mention regex needs to change
- **What:** Qualified-mention parsing (`@user@host`) is implemented twice: once in
  `@tavern/shared` (used by the API for envelope construction) and once in
  `apps/web/src/lib/markdown.ts` (used by the renderer for pill injection). The two
  regex implementations must move in lockstep. Deduplication — exporting one shared
  parser from `@tavern/shared` and importing it in the web layer — would eliminate the
  drift risk. Not urgent while both implementations are simple, but worth doing before
  the pattern grows more complex.

### 11. Per-route rate limit for `GET /api/federation/users/:remoteUserId/profile`

- **Phase:** 2 (whole-phase review)
- **Trigger:** same as follow-up #2 (before public-internet deployment)
- **What:** The authenticated profile-lookup endpoint triggers an outbound fetch on cache miss. The global 300 req/min limit is insufficient — a single authenticated user can enumerate hundreds of unique remoteUserIds and each triggers an external HTTPS call. Cap this route to ~10–20 req/min per authenticated user when the per-route rate-limit infrastructure from #2 lands.

### 12. `img-src` CSP for federated avatar hosts

- **Phase:** 2 (whole-phase review)
- **Trigger:** when avatar federation is expected to work (coordinate with #7)
- **What:** `RemoteUserCard` renders `avatarUrl` directly in `<img src>`. The web frontend's CSP `img-src` directive must be extended to allow cross-origin Tavern hosts. No code change needed for Phase 2 since the URLs return 401 anyway (per #7), but both must land together when avatar federation becomes functional.

### 13. `MAX_CLOCK_SKEW` guard for inbound `editedAt` / `deletedAt`

- **Phase:** 3 (P3-8 review)
- **Trigger:** before production federation rollout
- **What:** P3 follow-up: add a `MAX_CLOCK_SKEW` guard around inbound `editedAt` / `deletedAt` timestamps in `federation-inbound.ts` before production federation rollout. A malicious peer can otherwise set arbitrary timestamps that only affect UI sort. Severity: low; cosmetic gap, no security boundary crossed.

### 14. `MessageEdit.editedBy` attribution for federated edits

- **Phase:** 3 (P3-8 review)
- **Trigger:** when moderation propagation lands (Phase 7)
- **What:** P3 follow-up: `MessageEdit.editedBy` for a federated edit currently uses the local mirror of the remote author's User row. This will be wrong if Phase 7 introduces moderator edits. Revisit when moderation propagation lands.

### 15. Custom-emoji reactions across federation

- **Phase:** 3 (P3-9)
- **Trigger:** Phase 4+ (when cross-instance emoji sharing is on the menu)
- **What:** Inbound `reaction.add` / `reaction.remove` with a `custom:<id>` payload is rejected with 403 in Phase 3 (`federation-inbound.ts::validateInboundReaction`). The custom-emoji id only resolves on the home instance, and we don't yet have a story for transporting or rendering the underlying bytes on the receiver. Unicode reactions only for now. Phase 4+ candidate fixes: bundle the emoji's bytes in the envelope, or define a `custom-emoji:request` lookup analogous to `profile.request`. Outbound side currently still emits whatever the local PUT route accepted — the gate is enforced on the receiver. Revisit when cross-instance custom emoji becomes a roadmap item.

### 16. Dead-letter inspection / retry for the federation outbox

- **Phase:** 3 (P3-13)
- **Trigger:** Phase 4+ (operational visibility)
- **What:** The federation outbox dispatcher retries 3× with exponential backoff, then drops the job into BullMQ's `failed` ring. There is no admin UI surface for inspecting, retrying, or purging dead-letter jobs. Operators currently have to shell into Redis (or use a separate BullMQ dashboard) to see what failed. Add an admin route + UI for listing failed federation jobs with a "retry" / "discard" action. Folds naturally into Phase 4 when richer outbox semantics arrive (invite envelopes, member-mutation envelopes, etc.).

### 17. Brittle signature-failure-reason regex in `federation-inbound.ts`

- **Phase:** 3 (P3-13)
- **Trigger:** before adding more inbound envelope kinds (Phase 4+)
- **What:** `federation-inbound.ts` currently distinguishes "signature failed" (401) from "envelope malformed" (400) by string-matching the `reason` field returned by `verifyTwoLayerMessageEnvelope`. The regex is brittle and silently miscategorises any new failure mode the verifier introduces. Fix: change `verifyTwoLayerMessageEnvelope` to return a discriminated `{ kind: 'sig_failure' | 'envelope_invalid' | 'expired' }` on the failure branch, and dispatch on `kind` in the inbound handler.

### 18. Async delivery of `member.joined` / `member.removed` acks

- **Phase:** 4 (P4-15)
- **Trigger:** if/when async out-of-band delivery of join/leave acks is needed
- **What:** `member.joined` (P4-7) and `member.removed` (P4-12) are single-layer
  signed envelopes returned as the synchronous HTTP response to a
  `member.join_request` / `member.leave` POST. The originating peer's calling
  code consumes the response inline via `postFederationEventSync`, so these
  event types are intentionally not registered in `HANDLERS` in
  `federation-inbound.ts` — a peer that posts one to `/_federation/event` gets
  a 501, which is the correct behaviour for that misuse. The two-layer
  dispatcher also literally cannot verify them (no user-layer signature is
  present). If we ever need to deliver these acks out-of-band (e.g. retry
  after a sync timeout, or instance-to-instance ack relay), the dispatcher
  has to grow a single-layer verification path that bypasses the
  `extractAuthorRemoteUserId` / `RemoteUser` lookup and verifies only the
  instance signature. No action needed until that delivery mode is on the
  roadmap.

### 19. Two-instance integration test infrastructure

- **Phase:** 4 (P4-17)
- **Trigger:** before relying on federation regression coverage in CI
- **What:** The P4-17 end-to-end smoke test fell back to a single-instance
  simulation because the existing test harness has one shared Prisma client and
  one in-process outbox dispatcher. A faithful two-instance integration test
  needs per-app Prisma overrides (so instance A and instance B own separate
  databases) and a per-app outbox dispatcher (so envelopes from A actually
  cross to B rather than short-circuiting). Without this, every cross-instance
  envelope path is exercised only by unit tests + manual docker-compose runs.
  Track as the prerequisite for any future federation integration test that
  claims to cover both sides of the wire.

### 20. Role mirroring beyond synthetic `@everyone`

- **Phase:** 4 (deferred)
- **Trigger:** Phase 7 (moderation propagation)
- **What:** Phase 4 mirrors create a single synthetic `@everyone` role with
  `PERMISSION_DEFAULT_EVERYONE` for every member of a mirror den. Per-Tavern
  roles defined on the home instance do not federate, in line with the
  "trust does not transit" stance. When Phase 7 lands moderation propagation,
  revisit: at minimum the moderator role probably needs to mirror so that a
  banned user is banned on every mirror. Likely scope is a narrow "moderator
  flag" rather than full role-tree mirroring.

### 21. Invite revocation propagation

- **Phase:** 4 (P4-6 review)
- **Trigger:** when invite revocation needs to be authoritative across peers
- **What:** Revoking a federated invite on the home instance does not push
  any envelope to peers. In-flight accepts still fail at the home's check
  (the home enforces the revocation on `member.join_request`), so the
  invariant holds, but the joining instance's UI can show a stale "this
  invite is valid" preview until the user actually clicks accept. Add an
  `invite.revoked` envelope that pushes to peers known to have previewed
  the invite, so their preview UIs can update live.

### 22. Federated Tavern owner change

- **Phase:** 4 (deferred)
- **Trigger:** Phase 7 (moderation / ownership transfer)
- **What:** Phase 4 mirrors track the home Tavern's owner via the snapshot
  in `member.joined` plus the live member.* envelopes, but ownership transfer
  on the home does not emit a dedicated envelope kind. If the home owner
  changes, mirrors will only learn about it on the next snapshot-bearing
  envelope (none currently exist outside of join acks). Define an
  `server.owner_changed` envelope as part of the Phase 7 moderation surface,
  and have mirrors update the local `Server.ownerId` / synthetic role
  membership accordingly.

### 23. Avatar / icon byte mirroring

- **Phase:** 4 (related to #7)
- **Trigger:** when avatar / icon federation is expected to actually render
- **What:** Phase 4 mirrors reference the home instance's URLs for Tavern
  icons (and member avatars via #7's existing gap). Browser-side `<img>`
  fetches will hit the home instance with no session, so they will 401 until
  the public media proxy / signed-URL / inline-bytes solution from #7 lands.
  Scope expands from "remote user avatars" to "remote Tavern icons" — same
  fix, broader surface. Coordinate with #7 and #12 (CSP).

### 24. `POST /api/servers` response missing `originInstance` join

- **Phase:** 4 (whole-phase review)
- **Trigger:** when other server-creation API polish lands
- **What:** The Tavern-creation endpoint returns the new `Server` row but
  does not include the `originInstance` relation in its response shape,
  unlike `GET /api/servers/:id` which does. Low risk and matches the
  pre-existing style for create endpoints, but a client that immediately
  needs the origin instance after create has to issue a follow-up GET.
  Fold in when the create endpoint is next touched.

### 26. Group DM federation

- **Phase:** 5 (deferred)
- **Trigger:** when group DM federation is on the roadmap
- **What:** Phase 5 covers 1:1 DMs only. Group DMs (3+ participants) are
  intentionally deferred — the cross-instance fan-out math, the
  mirror-on-every-participant-instance topology, and the moderation surface
  (a group member from instance C is added to a 1:1 between A and B) all
  need design work. The Phase 5 schemas and envelopes are 1:1-shaped; group
  DM federation will need new envelope kinds or a generalization of the
  existing ones. Revisit once the 1:1 path has run in production for a
  while and the use case demand is clear.

### 27. DM moderation propagation

- **Phase:** 5 (deferred to Phase 7)
- **Trigger:** Phase 7 (moderation propagation)
- **What:** Phase 5 federates DM content but not moderation actions. A user
  blocked on instance A is not blocked on instance B; a user banned from
  the platform on A can still DM B users via B's mirror of their account.
  Block lists, banned-user enforcement, and "report this DM to the home
  instance" flows are Phase 7 work. Until then, users should rely on
  per-DM mute / leave actions, which stay local.

### 30. Existing pre-Phase-5 `RemoteInstance` rows hold un-intersected capability sets

- **Phase:** 5 (P5-11 review)
- **Trigger:** when Phase 5 ships to instances with existing peers
- **What:** P5-11 introduced capability intersection on the peering
  handshake going forward, but did not migrate existing `RemoteInstance`
  rows that were peered before Phase 5 deployed. Those rows hold the
  un-intersected capability set from the original handshake, which means
  a Phase 5 instance peered with a pre-Phase-5 instance may incorrectly
  think the peer supports `dms` (or, more dangerously, may not know the
  peer rejects DMs and try to fan out anyway). Mitigations: either
  re-handshake all existing peers as part of the Phase 5 deployment
  runbook (operator action), or add a one-shot migration that nulls
  `capabilities` on all rows + forces a re-fetch on next contact (code
  change). Document the operator path in the Phase 5 release notes.

### 34. Silent dead-letter on outbound `dm.create` rejection (`recipient_refuses_federated_dms`)

- **Phase:** PF / Federation polish (post-Phase 6)
- **Trigger:** when federation outbox dead-letter visibility (#16) lands
- **What:** When a local user starts a federated DM with a remote user
  whose home instance returns 403 `recipient_refuses_federated_dms`
  (because the recipient opted out via PF-4's account-settings toggle),
  the BullMQ dispatcher converts the 403 into a
  `FederationOutboxPermanentError` and dead-letters the job silently.
  The initiator's local `DmChannel` exists; the initiator can write
  messages into it; no messages ever reach the remote recipient; the
  UI shows no error. The plan's R4 risk note accepted this as a
  limitation, but it remains a real UX gap until either (a) the
  dead-letter UI from follow-up #16 lands so operators can surface
  failed jobs to the user, or (b) the worker grows a gateway-publish
  path that emits a `DM_FEDERATION_REFUSED` event back to the
  originating user's client. Choice (b) is the cleaner UX — it routes
  the signal to the person who needs it (the initiator) rather than
  to the operator. Severity: medium — no data integrity issue, but a
  user-confusion bug. The same dead-letter path also covers
  capability-dropped, peering-revoked, and recipient-deleted cases;
  the fix should not be specific to the `recipient_refuses_federated_dms`
  string.

## Resolved

### Phase 4 pre-prod review (2026-05-29)

Verified the pre-prod checklist against live code — most items were already implemented in earlier phases (the doc lagged the code):

- **#1 key fingerprint:** DONE — `FederationPeeringService.listPeers()` returns `keyFingerprint` (truncated SHA-256 of `instanceKey`, colon-hex), rendered as a "Fingerprint" column in `PeersTable.tsx`.
- **#2 per-route rate limits:** DONE — `/_federation/peering` is capped at 10/min and `/.well-known/tavern-federation` at 60/min via per-route `config.rateLimit` (not the global 300/min).
- **#3 `FederationEnvelopeLog` retention sweep:** DONE — `apps/worker` schedules a daily (`30 3 * * *`) `federation-envelope-retention` repeatable job that batch-prunes rows with `receivedAt` older than 30 days, using the `(peerInstanceId, receivedAt)` index.
- **#4 `window.prompt` revoke-reason:** DONE — replaced by `RevokePeerModal` in `admin-federation-page.tsx`.
- **#6 `assertValidPeerHost` (partial):** `*.local` / `*.localhost` now rejected synchronously (this review); the private-IP DNS check was already present. `*.internal` + DNS-rebinding remain (low severity).
- **#16 dead-letter UI:** DONE — `admin-federation-page.tsx` lists failed outbox jobs with retry/discard, backed by `/api/admin/federation/dead-letters`.

**Remaining pre-prod gap:** #7 (federated avatar/icon URLs 401) — needs a public media proxy, signed URLs, or inline bytes; coordinate with #12 (CSP) and #23 (icon scope). A design decision, deferred per the original note.

### Phase 2 post-review fix-up

- **SSRF guard on outbound profile fetch.** `assertValidPeerHost` is now exported from `federation-peering.ts` and applied in `FederationProfileService.fetchRemoteProfile` immediately after `parseRemoteUserId`. The inbound `respondToProfileRequest` handler intentionally skips the guard (no outbound fetch on that path) — documented inline.

### 29. `peering.accept` envelope inbound handler missing — resolved in Phase 6 (P6-3)

- **Resolution:** P6-3 added `FederationPeeringService.recordInboundAccept` and
  event-type dispatch on `POST /_federation/peering`. The route now routes
  `peering.request` → `recordInboundRequest` (existing) and `peering.accept`
  → `recordInboundAccept` (new); unknown event types return 400. The new
  handler verifies the envelope against a fresh discovery-doc public key
  (supports peer key rotation), intersects the peer's accepted capabilities
  with the local advertised set, flips a `pending_outbound` row to `peered`,
  and handles re-handshake on an already-`peered` row by refreshing
  capabilities + key. Rejects unknown peers (`bad_envelope`),
  revoked/blocked rows (`blocked`), bad signatures (`signature`), and
  nonce replays (`replay`). Closes the asymmetric-capability gap that
  could keep the initiator believing a peer still supports a capability
  the peer has dropped — relevant for the new Phase 6 `presence`
  capability as well as the existing `dms`.

### 31. Idempotent-delete short-circuit ordering leaks soft-delete state — resolved in Phase 6 (P6-4)

- **Resolution:** P6-4 reordered `handleMessageDelete` and
  `handleDmMessageDelete` in `apps/api/src/services/federation-inbound.ts`
  so the author-only check fires BEFORE the
  `existing.deletedAt → deduplicated: true` short-circuit. A non-author
  replaying a delete envelope now consistently receives 403 `forbidden`
  whether or not the target message was previously soft-deleted, closing
  the status-difference oracle that could probe soft-delete state.
  Legitimate authors are unaffected: a redeleting author still gets
  `200 deduplicated: true` on an already-deleted message. Both DM and
  server-message handlers were updated together; integration tests
  cover the non-author-on-deleted-message branch returning 403.

### 9. Member-list integration for remote users — resolved in Phase 4 (verified PF-6)

- **Resolution:** Phase 4's invite + mirror flow materialises a synthetic
  local `User` row (with `remoteInstanceId` + `remoteUserId` set) plus a
  `ServerMember` row for every joined remote user. The
  `GET /api/servers/:id/members` route in `apps/api/src/routes/servers.ts`
  reads `serverMember` rows blind to whether the joined user is local or
  remote, so mirror members fall out of the same query and render in the
  sidebar with the synthetic display name + the `User.presence` value.
  Confirmed by `apps/api/test-integration/federation-member-list.test.ts`,
  which seeds a peered `RemoteInstance`, a `RemoteUser` cache, the
  synthetic local `User`, and a `ServerMember` row, then asserts the
  endpoint returns the remote member alongside the local owner with the
  correct id, displayName, and presence.

### 25. `MEMBER_REMOVE` broadcast with `userId: null` — resolved in Phase 4 (verified PF-6)

- **Resolution:** The current `handleMemberRemove` /
  `handleMemberLeave` paths in `apps/api/src/services/federation-inbound.ts`
  resolve the local mirror User row via
  `prisma.user.findUnique({ where: { remoteUserId: payload.memberRemoteUserId } })`
  BEFORE the mirror service removes the row, and include the local id in
  the gateway broadcast (`gatewayBroker.publish({ type: 'MEMBER_REMOVE',
  serverId, data: { serverId, userId: localUserId } })` around lines
  2809-2811 and 2964-2966). Receivers therefore see the local mirror id —
  not `null` — and can drop the right row from the sidebar / presence
  store. Confirmed by an additional assertion in
  `apps/api/test-integration/federation-inbound.test.ts`'s P4-11
  `member.remove` happy-path test, which captures the gateway broadcast
  and asserts `payload.userId === subjectLocalId` (the synthetic mirror
  User id) and `payload.userId !== null`.

### 28. Per-user "disable federated DMs" preference — resolved in federation-polish batch (PF-4)

- **Resolution:** PF-1 added `User.acceptsFederatedDms Boolean @default(true)`
  to the Prisma schema, and PF-4 wired both sides of the gate.
  Inbound: `handleDmCreate` in
  `apps/api/src/services/federation-inbound.ts` now reads
  `acceptsFederatedDms` on the resolved local recipient after
  `parseLocalPart(payload.recipientRemoteUserId)` and throws
  `FederationInboundError('recipient_refuses_federated_dms', ...)` when
  false; the route's `statusForCode` switch maps the new code to HTTP
  403. Outbound: `POST /api/dms/direct` translates that specific 403
  response from the peer into a user-facing error code so the UI can
  render an explanation and roll back the optimistic local DmChannel.
  PF-5 added the "Accept new direct messages from federated peers"
  toggle in account settings, rendered only when the instance advertises
  the `dms` capability. The gate fires at `dm.create` only — existing
  federated DMs stay open per the architecture decision (closing them
  unilaterally is a Phase 7 moderation action). Integration tests in
  `apps/api/test-integration/federation-inbound.test.ts` cover the
  inbound 403, the happy-path `acceptsFederatedDms=true`, and the
  "existing DM keeps receiving messages after opt-out" branch.

### 32. `PRESENCE_UPDATE` WS event doesn't carry customStatus — resolved in federation-polish batch (PF-2)

- **Resolution:** PF-1 extended `presenceUpdatePayloadSchema` in
  `packages/shared/src/schemas/presence.ts` with optional
  `customStatus: z.string().min(1).max(128).nullable().optional()` and
  `customStatusExpiresAt: z.string().datetime().nullable().optional()`.
  PF-2 changed `presence-service.ts::broadcast` to read all three fields
  (`presence`, `customStatus`, `customStatusExpiresAt`) from the User
  row in the same `findUnique` already used for fan-out gating, and
  include them in every `PRESENCE_UPDATE` envelope; the inbound
  `handlePresenceUpdate` post-commit broadcast in
  `federation-inbound.ts` does the same for mirror writes. Web:
  `apps/web/src/lib/realtime.ts` parses the new fields and dispatches a
  `setCustomStatus(userId, status, expiresAt)` action on the store;
  absent fields are treated as "no change" so presence-only broadcasts
  don't clobber the custom-status map. `MemberProfileCard` and
  `MemberSidebar` resolve the pill as
  `customStatusByUserId.get(userId)?.status ?? profile.customStatus` so
  live updates win over cached snapshots. Expiry is wall-clock-evaluated
  on the receiver, matching the existing profile-fetch path. Coverage:
  one server integration each for the local-presence-change and
  inbound-federation paths, plus a web unit test asserting absent fields
  don't overwrite the customStatus store.

### 33. Per-user "invisible to federated peers" presence opt-out — resolved in federation-polish batch (PF-3)

- **Resolution:** PF-1 added `User.acceptsFederatedPresence Boolean @default(true)`
  to the Prisma schema, and PF-3 wired the outbound-only gate.
  `presence-service.ts::emitFanOut` extended the existing `findUnique`
  (already used to confirm `remoteInstanceId IS NULL` for home-only
  fan-out) to also read `acceptsFederatedPresence`; when false, the
  function returns early before any envelope is enqueued and emits a
  structured log line (`federation presence fan-out skipped — user has
  acceptsFederatedPresence=false`). Local gateway broadcast still fires
  — the user's presence still renders for their own tabs and local
  members; only the federation envelope is suppressed. The check is
  outbound-only by design: there's no inbound presence opt-out because
  peers send presence for their own users, and filtering would just
  leave the UI showing stale dots (architecture decision #2). PF-5
  added the "Share my presence with federated peers" toggle in account
  settings, rendered only when the instance advertises the `presence`
  capability AND `FEDERATION_PRESENCE_ENABLED=true`. Test coverage
  includes the debounce-window race documented in risk R1: flipping the
  preference mid-debounce-window causes the pending flush to re-read
  the User row and short-circuit, so no stale envelope leaks out.
