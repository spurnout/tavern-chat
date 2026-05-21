# IR20 federation network — design

> **Status: Phase 0–6 implemented.** Peering, remote-user identity, federated
> channel messages/edits/deletes/reactions, federated invites with full Tavern
> mirroring, federated 1:1 direct messages, AND **federated presence + custom
> status** (presence transitions and custom-status changes propagate to peers
> that share a federated Tavern or DM with the user, gated on the `presence`
> capability and the `FEDERATION_PRESENCE_ENABLED` env var). Moderation
> propagation and voice are still pending. See [Rollout phases](#rollout-phases).
> All 7 open design questions are locked per the recommendations below.
> Phases 7 and 8 are pending. See [Rollout phases](#rollout-phases).

Tavern was originally framed as a closed-graph, self-hosted community
app. The IR20 work reverses that stance: identity, invites, messages,
presence, and (eventually) voice cross Tavern instances. **IR20** is a
working name; the final brand is undecided.

## Goals (V1)

- Users on instance A can be invited to and participate in Taverns
  hosted on instance B without re-registering.
- Messages, edits, deletes, and reactions cross instances reliably with
  eventual consistency.
- Remote users appear in member lists, mentions, DMs, and presence
  fanout — clearly tagged as remote, with their home instance visible.
- Instance operators retain hard control over which peers they trust.
  Federation is opt-in per pair, not promiscuous.
- Per-Tavern toggle: a Tavern owner can stay fully local even on a
  federated instance.
- Per-channel toggle: sensitive channels (GM-only, mod-only) can stay
  non-federating even inside a federated Tavern.
- Moderation actions (bans, content blocks) propagate to peers that
  have seen the offending data.

## Non-goals (V1)

- **Federated voice/video.** LiveKit doesn't federate today. Voice stays
  single-instance — remote members see voice channels exist but cannot
  join. Pushed to V2.
- **End-to-end encryption** of federated content. E2EE + federation +
  moderation is a hard four-way problem; defer.
- **Public discovery directory.** IR20 is peering, not a search engine
  for Taverns. A separate registry can layer on top later.
- **ActivityPub / Matrix interop in the same release.** Adapters can
  come later; V1 ships one protocol — its own.
- **Cross-instance permission propagation.** A user's role on instance
  A grants nothing on instance B.
- **Account portability.** Identifiers are not portable across
  instances. Migration is out of scope.

## Terminology

| Term | Meaning |
|------|---------|
| **Instance** | A Tavern deployment with its own domain, DB, and operator. |
| **Home instance** | The instance where a user account was created. Authoritative for that user's identity. |
| **Remote user** | A user whose home instance is not this one. |
| **Federated Tavern** | A Tavern whose owner has enabled federation; remote members can join via federated invite. |
| **Peer** | Another instance that this one has explicitly agreed to talk to. |
| **Envelope** | A signed, transport-agnostic message carrying a federation event. |

## Open design questions (resolve these first)

Load-bearing decisions. Lock them down before writing protocol code.

1. **Protocol family.** Tavern-native (recommended), Matrix,
   ActivityPub, or hybrid? See [§Protocol choice](#protocol-choice).
2. **Identity format.** `user@instance.example.com` (email-shaped,
   familiar) vs. opaque DID (`did:tavern:abc...`). Recommend the former.
3. **Transport split.** HTTPS-only request/response vs. long-lived WSS
   server-to-server channel. Recommend both — control over HTTPS, live
   fanout over WSS.
4. **Remote-user permissioning.** Single auto-assigned `@federated`
   role for V1, or fully assignable like a local user? Recommend the
   former — simpler trust story.
5. **DM scope.** Federated DMs by default, or opt-in per instance?
   Recommend opt-in per instance and per user.
6. **Mention semantics.** Local `@alice` vs. qualified
   `@alice@b.example`? Recommend both — local form for local users,
   qualified form for remote.
7. **Backfill window.** How far back does a freshly-peered instance
   pull historical messages? Recommend "no backfill" — federation
   starts from the peering moment.

## Identity model

Each user has a stable identifier `user@instance`. The local part is
the username on the home instance; the host part is the instance's
primary domain.

- Identifiers are **not portable**. Migrating accounts between
  instances is out of scope.
- Each user holds an Ed25519 keypair generated at registration. Public
  key published by the home instance; private key never leaves it.
- Each instance holds an Ed25519 instance key. Used to sign every
  outbound envelope and to assert "this user is mine".
- Cross-instance authorization is **two-layer**: the user signs the
  payload, the home instance signs over the user signature.

> **Why two layers?** The user signature proves the action came from
> the user. The instance signature proves the home instance is still
> vouching for the user — so revocation, bans, and account deletion on
> the home instance poison previously-issued signatures.

## Trust & peering model

V1 federation is **explicit, mutual, and revocable**. No open
federation, no automatic peering.

### Peering lifecycle

1. **Discovery.** Operator A enters `b.example.com` in the admin UI.
   The local instance fetches
   `https://b.example.com/.well-known/tavern-federation` and pulls B's
   instance key, version, and advertised capabilities.
2. **Pending.** A's request lands in a queue on B. B's operator must
   explicitly approve.
3. **Peered.** Once both sides approve, the pair is recorded in
   `RemoteInstance` on both sides with status `peered`.
4. **Revocation.** Either side can drop the peering at any time. On
   revocation, both sides hard-delete cached remote-user records, mark
   federated content from the dropped peer as redacted, and broadcast
   `FEDERATION_PEER_REMOVED` to local clients.

### Capability negotiation

Peers exchange a capability set at peering time:

- `messages` — federate channel messages (mandatory)
- `dms` — federate direct messages between users on the two instances
- `presence` — federate presence updates
- `invites` — accept federated invites
- `moderation` — accept ban / block propagation

A peer may advertise a subset; the local operator accepts or rejects
per capability. The handshake stores the **intersection** of (what we
advertise, what the peer advertises/requests) in
`RemoteInstance.capabilities`, and every outbound fan-out and inbound
handler reads that stored set to decide whether to act.

#### Per-capability operator opt-out

Each capability has a corresponding env-var switch the operator can
flip without re-peering:

| Capability | Env var                  | Default |
|------------|--------------------------|---------|
| `dms`      | `FEDERATION_DMS_ENABLED` | `true`  |

When set to `false`:

- The instance does NOT advertise that capability in its
  `.well-known/tavern-federation` doc, so future peer handshakes
  intersect it out automatically.
- Every outbound fan-out helper for that capability short-circuits at
  the route layer before touching the queue.
- Every inbound handler for that capability rejects with HTTP 403
  `dms_capability_missing` (or the capability-equivalent code) BEFORE
  consulting the peer's stored capability set. This protects against a
  peer whose `RemoteInstance.capabilities` row still carries the old
  advert from when this instance still supported the capability.

`FEDERATION_DMS_ENABLED=false` requires `FEDERATION_ENABLED=true` to
have any effect; with federation fully off the per-capability flags
are meaningless.

### Trust does not transit

Peering is **not transitive**. If A peers with B and B peers with C, A
and C do not federate. Operators choose their own peer graph.

## Protocol choice

Three serious options. Recommendation: **Tavern-native** for V1.

### Option 1: Tavern-native (recommended)

A small Tavern-specific protocol on top of well-known primitives.

- **Transport:** HTTPS for control plane (peering handshake, capability
  exchange, message backfill), WSS for the live event channel between
  paired instances.
- **Authentication:** Ed25519 signed envelopes. Two-layer signatures
  per [§Identity model](#identity-model).
- **Payloads:** the existing zod schemas in `packages/shared` for
  events (`MESSAGE_CREATE`, `MEMBER_UPDATE`, etc.), wrapped in a signed
  envelope.
- **Pros:** fits the data model exactly, no JSON-LD overhead, full
  control over the security model, smaller surface area to audit.
- **Cons:** no ecosystem, no existing bridges, all protocol ownership
  on us. Documentation burden.

### Option 2: Matrix

Use Matrix's federation protocol. Tavern becomes a specialised Matrix
client/server hybrid; rooms map to channels.

- **Pros:** mature protocol, voice already uses LiveKit (Element Call),
  strong moderation primitives, real ecosystem of bridges.
- **Cons:** Tavern's data model (Taverns, channels, threads, campaigns,
  dice, characters, handouts) does not map cleanly to Matrix rooms.
  Either lose semantics or bolt custom event types on top. Significant
  operational complexity (Synapse, state resolution). Effectively makes
  Tavern a Matrix client at the protocol layer.

### Option 3: ActivityPub

The Fediverse protocol (Mastodon, Lemmy, etc).

- **Pros:** widest deployed federation protocol.
- **Cons:** designed for public-by-default social media, not private
  community chat. JSON-LD overhead. Voice unaddressed. Realtime channel
  semantics awkward over AP's push/pull model.

### Why Tavern-native wins for V1

Tavern is already an opinionated, self-contained data model. Adopting
Matrix or AP means either (a) constraining new Tavern features to fit
the protocol or (b) eating the legacy of a general-purpose protocol
just to reach instances that are not Tavern. The peer set in practice
is going to be other Tavern instances. A custom protocol ships faster,
audits cleaner, and adapters can layer on later if interop matters.

## Cryptography

- **Instance signing key:** Ed25519. Long-lived. Rotated by issuing a
  new key signed by the old (30-day overlap). Operators can publish a
  revocation event that peers honour immediately.
- **User signing key:** Ed25519. One per user. Rotated on password
  change or explicit request. Old keys remain valid for verifying past
  events but cannot sign new ones.
- **Envelope hashing:** BLAKE3 over the canonical JSON payload.
- **Canonical JSON:** RFC 8785 / JCS. We do not invent our own.
- **Replay protection:** envelopes carry `nonce` (ULID) and
  `notBefore` / `notAfter` timestamps. Receivers maintain a sliding
  window of seen nonces per peer (30-day retention).

## Discovery

Each federated instance publishes a discovery document at
`https://<host>/.well-known/tavern-federation`:

```json
{
  "instance": "example.com",
  "softwareVersion": "tavern/1.x.y",
  "protocolVersion": "ir20/1",
  "instanceKey": "ed25519:base64-...",
  "endpoints": {
    "peering":  "https://example.com/_federation/peering",
    "events":   "wss://example.com/_federation/events",
    "backfill": "https://example.com/_federation/backfill"
  },
  "capabilities": ["messages", "dms", "presence", "invites", "moderation"]
}
```

The host itself is the identifier and the `.well-known` path is the
canonical lookup. No DNS SRV records or central registry required.

## Data model additions

New Prisma models:

- **`RemoteInstance`** — `id`, `host`, `instanceKey` (current),
  `previousInstanceKey` (rotation overlap), `status`
  (`pending_inbound | pending_outbound | peered | revoked | blocked`),
  `peeredAt`, `peeredBy` (admin user id), `capabilities[]`,
  `revokedAt`, `revokedReason`.
- **`RemoteUser`** — `id`, `remoteInstanceId`, `remoteUserId`
  (`localpart@host`), `displayNameCache`, `avatarUrlCache`,
  `publicKey`, `lastSeenAt`. Cached projection — home instance is
  always authoritative.
- **`FederationEnvelopeLog`** — debug + replay log. `id`, `direction`,
  `peerInstanceId`, `eventType`, `payloadHash`, `nonce`, `receivedAt`,
  `processedAt`, `status`, `errorMessage`. Retained ~30 days.
- **`FederatedSubscription`** — per-Tavern peering settings. `id`,
  `serverId`, `enabled`, `defaultRemoteRoleId`, `channelOverridesJson`
  (which channels federate / don't).
- **`FederationKey`** — instance signing keys (current + previous, with
  rotation timestamps). Private half stored encrypted via the same
  key-at-rest mechanism the API already uses for secrets.

Updates to existing models:

- `User.federationKey` — local user signing key public half (nullable
  Bytes).
- `User.remoteUserId` — nullable; set on remote users only.
  Cross-references `RemoteUser.id`. Tracking remote users as `User`
  rows keeps the rest of the schema simple — messages, reactions, and
  members already reference `User`.
- `Message.signature` — present on federated messages, null on
  local-only.
- `Message.originInstanceId` — set on inbound federated messages.
- `Server.federationEnabled` — bool, default `false`.
- `Channel.federationMode` — enum `inherit | force_on | force_off`.

## Federated message lifecycle

### Outbound (local → remote)

1. User posts to channel `C` in federated Tavern `T`.
2. API writes the message locally (same path as today).
3. After commit, the federation outbox enqueues an envelope per peer
   that has at least one member in `T`.
4. Worker dispatches each envelope over the peer's WSS event channel
   (HTTPS POST backfill if WSS is down). Retries with backoff.
5. On peer ack, envelope marked `delivered`. Unacked envelopes beyond
   24h surface in the admin UI as delivery failures.

### Inbound (remote → local)

1. Peer's WSS connection delivers an envelope.
2. Verify two-layer signatures, nonce window, and
   `notBefore`/`notAfter`.
3. If the envelope references a Tavern + channel this instance hosts
   and federation is enabled, persist the message with
   `originInstanceId` set and signature stored.
4. Broadcast `MESSAGE_CREATE` over the normal gateway to local members
   with `VIEW_CHANNEL`.
5. Update the remote user's `lastSeenAt`.

### Edits, deletes, reactions

Same envelope shape — `MESSAGE_UPDATE`, `MESSAGE_DELETE`,
`REACTION_ADD`, `REACTION_REMOVE`. Edits accepted only from the
original signer (or the home instance under a moderation envelope).
Deletes accepted from the original signer OR a moderator on either
instance.

## Federated invites & Tavern joining

A federated invite is a normal invite extended with a `remoteScope`:

```json
{
  "code": "abc123",
  "serverId": "...",
  "remoteScope": "any_peer | specific_instance | specific_user",
  "remoteInstanceHost": "b.example.com",
  "remoteUserId": "alice@b.example.com"
}
```

Joining flow — Alice (on B) accepts a federated invite to Tavern T (on A):

1. B's UI shows the invite preview, fetched from A's
   `/_federation/invite-preview/:code` endpoint.
2. Alice confirms.
3. B sends `MEMBER_JOIN_REQUEST` envelope to A, signed by Alice and B.
4. A creates a `Member` row referencing Alice's `RemoteUser`, assigns
   the Tavern's `defaultRemoteRoleId` (per `FederatedSubscription`),
   and broadcasts `MEMBER_ADD` locally.
5. A acks back to B with `MEMBER_JOINED`. B records the association so
   Alice's client sees Tavern T in her server list.

Alice's client now subscribes to Tavern T's federated event stream via
her home instance B (B relays from A).

## Federated DMs

DMs across instances require both peers to advertise the `dms`
capability.

- Identifier: `(remoteUserA, remoteUserB)` — both sides recorded as
  `RemoteUser` rows on each other's instance.
- Storage: each instance stores its own copy of the DM channel and
  messages. Kept in sync via envelopes (best-effort eventual
  consistency).
- Read state, drafts, and notification settings stay local —
  not federated.
- Group DMs across instances are out of V1 (start with 1:1).

## Federated presence

Optional — instances may opt out via the `presence` capability.

- The home instance is authoritative for a user's presence.
- A `PRESENCE_UPDATE` envelope is published to peers where the user
  shares at least one federated Tavern or DM.
- Receiving instance fans out to local clients per existing presence
  scoping rules.
- Custom status carries as a string + expiry timestamp.

## Federated moderation

Actions that propagate:

- **Account lock / deletion** on home instance → peers stop accepting
  envelopes from that user, soft-delete past content per the home
  instance's tombstone envelope.
- **Tavern-level ban** of a remote user → that user can no longer post
  into that Tavern. Other Taverns and other instances unaffected.
- **Instance-level block** of a peer → cuts WSS, marks past content
  from that peer as hidden, refuses inbound envelopes.
- **Content removal envelopes** (`MESSAGE_REMOVE`, `MEMBER_REMOVE`)
  signed by either the message author or a moderator on either
  instance.

All moderation envelopes use the two-layer signature. Receiving
instances log every accepted moderation envelope to `AuditLogEntry`.

**Out of V1:** subscribable "ban lists" or federation-ring shared
blocklists. Each instance applies its own moderation; we will not ship
a global blocklist subscription mechanism yet.

## Voice & video

Out of V1. Concrete plan, deferred:

- Voice channels remain single-instance. Remote members see voice
  channels in the channel list and can read who's in them, but cannot
  join.
- Future direction: SFU-to-SFU bridging between LiveKit instances, or a
  designated voice-home instance per Tavern. Both are open research.
- Watch parties and recordings are similarly single-instance.

## Privacy & threat model

### What leaks across the boundary

- Any message in a federated channel.
- The fact that a user exists, their display name, avatar, presence,
  and custom status (subject to capability opt-in).
- Tavern metadata for federated Taverns (name, icon, channel list —
  but not non-federated channels).

### What does not leak

- Local-only channels in a federated Tavern.
- Local-only Taverns on a federated instance.
- Notes / handouts / GM-only campaign data — regardless of channel
  federation, unless explicitly federated.
- Read state, drafts, notification preferences.
- IP addresses (envelopes carry instance identity, not user IP).

### Hostile peer assumptions

A paired peer **can**:

- See and store any federated content sent to it.
- Spoof envelopes from its own users (this is fine — that's the trust
  we extended by peering).

A paired peer **cannot**:

- Spoof envelopes from third-party instances (instance keys are tied
  to the discovery document at the peer's `.well-known` endpoint).
- Forge signatures from users on other instances.

If a peer goes rogue, the local operator revokes the peering and the
bond is cut. Past data already received cannot be unsent — this is a
fundamental property of federation and must be surfaced in the UI.

### What the operator must understand before flipping the switch

- Federation is opt-in, but once flipped on a Tavern, content is
  shared and cannot be retroactively un-shared. Tombstoning works for
  moderation, but peers may already have cached copies.
- Trust extends to the peer instance's operators, not just its users.
- A peer's moderation policy may not match yours.

This belongs in the federation onboarding UI as well as the docs.

## Rollout phases

| Phase | Scope |
|-------|-------|
| 0 | This doc; protocol freeze; threat-model review. |
| 1 | Discovery + peering handshake. No content yet. Admin UI shows pending / peered / revoked. |
| 2 | Remote-user identity. Mentions and profile previews work; messages do not yet federate. |
| 3 | Federated channel messages, edits, deletes, reactions. |
| 4 | Federated invites + Tavern joining. |
| 5 | Federated DMs (1:1). |
| 6 | Federated presence + custom status. |
| 7 | Federated moderation propagation (locks, removals, instance blocks). |
| 8 (V2) | Voice federation. |

Each phase is independently shippable. Earlier phases are reversible
(revoke peering) until phase 3 puts content on the wire.

## Compatibility & opt-out

- **Instance-wide opt-out:** `FEDERATION_ENABLED=false` (default until
  phase 2 ships). Disables the `.well-known` endpoint, refuses peering
  attempts, hides federation UI.
- **Per-Tavern opt-out:** `Server.federationEnabled = false`. A Tavern
  on a federated instance can stay fully local.
- **Per-channel opt-out:** `Channel.federationMode = force_off`. Useful
  for GM-only or moderator channels inside a federated Tavern.

A non-federated instance running on the same code path is a
first-class supported configuration. Federation is a feature, not the
new default.

## What the next thread should do first

1. Confirm or change the protocol-family decision
   ([§Protocol choice](#protocol-choice)).
2. Lock the [§Open design questions](#open-design-questions-resolve-these-first).
3. Write `packages/shared/src/federation/` zod schemas for the
   envelope types: `PeeringRequest`, `PeeringAccept`, `MessageEvent`,
   `ReactionEvent`, `PresenceEvent`, `ModerationEvent`. These become
   the protocol's source of truth.
4. Land Prisma migrations for `RemoteInstance`, `RemoteUser`,
   `FederationEnvelopeLog`, `FederatedSubscription`, `FederationKey`.
5. Implement phase 1 (peering handshake + admin UI) end to end. Get
   two dev instances peered before writing any message-event code.
6. Add a federation testbed: `docker-compose.federation.yml` standing
   up two Tavern instances with separate DBs on a shared bridge
   network so phase 1+ can be exercised locally.

## See also

- [architecture.md](architecture.md) — current single-instance
  architecture; federation overlays on top of this.
- [permissions.md](permissions.md) — permission model that does not
  cross instances.
- [safety.md](safety.md) — moderation primitives federation must
  respect.
- [roadmap.md](roadmap.md#planned-directions-post-wave-3) — where IR20
  sits in the wider roadmap.
