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
- **What:** Current guard rejects bare IPv4, IPv6, `localhost`, and dotless hostnames. Doesn't reject `*.local`, `*.internal`, RFC 1918 hostnames pointing at private IPs, or DNS rebinding tricks. A DNS resolution check (resolve hostname, refuse private IP ranges) is the strict fix. Defer until the route is publicly reachable.

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

### 9. Member-list integration for remote users (deferred to Phase 4)

- **Phase:** 2 (explicitly deferred)
- **Trigger:** Phase 4 (federated invites + Tavern joining)
- **What:** Remote users do not yet appear in Tavern member lists, even if mentioned.
  Full member-list integration requires the federated invite flow so remote users have
  a `Member` row on the hosting instance. This is an intentional Phase 4 deferral — noted
  here for traceability so Phase 4 planning picks it up.

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

### 25. `MEMBER_REMOVE` broadcast with `userId: null`

- **Phase:** 4 (whole-phase review)
- **Trigger:** when WS event payload cleanup is on the menu
- **What:** When a remote member is removed from a mirror Tavern, the
  `MEMBER_REMOVE` WebSocket broadcast carries `userId: null` (because the
  remote user doesn't have a local `User` row) alongside the qualified
  `remoteUserId`. Receivers ignore the null `userId` correctly, but the
  field is noise — schemas should accept `remoteUserId` as the sole
  identifier on remote-removal events. Not breakage; clean up when WS
  payload shapes are next revisited.

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

### 28. Per-user "disable federated DMs" preference

- **Phase:** 5 (whole-phase review)
- **Trigger:** when user-level federation preferences are added
- **What:** Phase 5 gates federated DMs at the instance level via the `dms`
  capability advertisement. There is no per-user opt-out — if both
  instances advertise `dms`, any local user can be DMed by any remote
  user (subject to the share-server gate). Some users may want to refuse
  federated DMs even when their instance supports them. Add a
  `User.acceptsFederatedDms` preference + UI toggle in account settings;
  initiator-side check before fan-out, receiver-side 403 with
  `recipient_refuses_federated_dms` on the inbound handler.

### 29. `peering.accept` envelope inbound handler missing

- **Phase:** 5 (P5-11 review; reaffirmed by Phase 5 whole-phase review as
  Important #2)
- **Trigger:** before relying on capability re-intersection after a peer
  reconfigures its advertised set
- **What:** P5-11 added capability intersection on the **inbound** peering
  handshake (B intersects A's advertised caps with B's own when accepting),
  but the **initiator** side (A) never reconciles the peer's accepted
  capabilities. If B drops `dms` from its advertisement after the initial
  peering, A's `RemoteInstance.capabilities` row for B still lists `dms`
  until A re-handshakes manually. Add a `peering.accept` inbound handler
  (or extend the existing accept ack) that lets B push its current
  capability set back to A on every handshake, including post-config
  changes triggered by a re-handshake request. **Phase 5 makes the
  consequence worse**: the new capability-intersection logic on accept
  never reaches the initiator, so A may keep enqueueing `dms` envelopes
  that B's inbound handler will reject on capability grounds. Phase 6
  scope.

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

### 31. Idempotent-delete short-circuit ordering leaks soft-delete state

- **Phase:** 5 (whole-phase review, Minor)
- **Trigger:** before any threat model assumes inbound author-only checks
  are not also a state-existence oracle
- **What:** `handleDmMessageDelete` in `apps/api/src/services/federation-inbound.ts`
  (and the parallel `handleMessageDelete` for server messages) checks
  `existing.deletedAt` BEFORE the author-only check. A peer holding a
  stolen / replayed envelope for a non-author can post it; if the message
  was previously deleted by anyone, the handler returns 200
  (`deduplicated: true`); otherwise it returns 403 (`forbidden`). The
  status difference probes whether the message was previously soft-deleted
  — a minor info leak, no data-integrity impact (the second branch still
  rejects the non-author mutation). Fix: reorder so the author check
  fires first, then the idempotent short-circuit. Both DM and server
  handlers share the pattern and should be fixed together.

## Resolved

### Phase 2 post-review fix-up

- **SSRF guard on outbound profile fetch.** `assertValidPeerHost` is now exported from `federation-peering.ts` and applied in `FederationProfileService.fetchRemoteProfile` immediately after `parseRemoteUserId`. The inbound `respondToProfileRequest` handler intentionally skips the guard (no outbound fetch on that path) — documented inline.
