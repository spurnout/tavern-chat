# Federation operations guide

Phases 1–6 of Tavern federation are now in place: peering, remote-user identity,
channel-message federation (create / edit / delete / reactions), **federated invites
plus Tavern mirroring** (members on one instance can join Taverns hosted on another, with
live server/channel/membership sync and home-instance message relay), **federated
1:1 direct messages** (DMs cross peers when both advertise the `dms` capability), and
**federated presence + custom status** (presence transitions and custom-status changes
propagate to peers sharing ≥ 1 federated Tavern or DM with the user, gated on the
`presence` capability and the `FEDERATION_PRESENCE_ENABLED` env var). Moderation
propagation and voice are still pending. Operators can safely enable peering, exchange
channel messages with peered instances at the per-Tavern and per-channel opt-in level,
federate invites end-to-end, exchange 1:1 DMs with remote users, surface live presence
across peers, and verify everything via the admin UI.

See `docs/federation.md` for the full design, protocol spec, and rollout phases.

---

## Environment variables

### `FEDERATION_ENABLED`

Controls the entire federation subsystem.

| Value | Effect |
|-------|--------|
| `false` (default) | Federation is completely off. The `/.well-known/tavern-federation` endpoint returns 404. The admin peering UI is hidden. Inbound peering requests are refused at the HTTP layer. |
| `true` | Federation is on. The discovery endpoint is live. Operators can initiate and approve peer requests via the admin UI. |

Setting `FEDERATION_ENABLED=true` does **not** federate any content by itself. It only
enables the peering handshake (Phase 1). Content federation (Phase 3+) requires per-Tavern
opt-in (`Server.federationEnabled`) and per-channel opt-in (`Channel.federationMode`), both
documented in the Phase 3 section below. DMs additionally require the `dms` capability to be
negotiated with the peer; presence additionally requires `FEDERATION_PRESENCE_ENABLED=true`
plus the `presence` capability.

### `TAVERN_DATA_KEY`

A 32-byte base64-encoded key used for at-rest encryption of secrets, including the
instance's Ed25519 signing key. Required when `FEDERATION_ENABLED=true`.

Generate a fresh key:

```bash
openssl rand -base64 32
```

Store it in your `.env` file or your secret manager. Do not commit it to source control.
Rotating this key requires re-encrypting stored secrets — use the admin key-rotation
procedure (see `docs/production-hardening.md`).

---

## Generating a `TAVERN_DATA_KEY`

```bash
# One-liner — pipe directly to your .env or secret store.
echo "TAVERN_DATA_KEY=$(openssl rand -base64 32)"
```

For production, inject it via your orchestrator's secret mechanism (Docker secrets,
Kubernetes secret, Vault, etc.) rather than writing it to a file on disk.

---

## Adding a peer (admin UI walkthrough)

### Prerequisites

- Both instances must have `FEDERATION_ENABLED=true`.
- Both operators must have admin access to their respective instances.
- Both instances must be reachable via HTTPS (self-signed certs are fine if both
  instances trust the same CA — see the testbed for how to do this locally).

### Step-by-step

**On instance A (initiating):**

1. Open **Admin → Federation → Peers**.
2. Click **Add peer**.
3. Enter the hostname of instance B (e.g. `b.example.com`).
4. Click **Send request**.

   Instance A fetches `https://b.example.com/.well-known/tavern-federation`, validates
   the discovery document, and saves a `RemoteInstance` row with status `pending_outbound`.

**On instance B (approving):**

5. Open **Admin → Federation → Peers**.
6. Find the inbound request from `a.example.com` (status: `pending_inbound`).
7. Review the instance key fingerprint shown in the UI — confirm it matches what you
   expect (e.g. contact the A operator out-of-band).
8. Click **Approve**.

   Instance B sends an acceptance back to A. Both sides record status `peered`.

**Back on instance A:**

9. Reload **Admin → Federation → Peers**.
10. The entry for `b.example.com` should now show **peered**.

### State diagram

```
A initiates                       B receives

  [none]                            [none]
    │                                 │
    ▼ (operator clicks Add peer)      │
pending_outbound ──────────────► pending_inbound
                                      │
                                      ▼ (B operator clicks Approve)
   peered ◄──────────────────────── peered
```

Both sides land in `peered` atomically from A's perspective once B's acceptance is
processed. If A is offline when B approves, A picks it up on the next poll cycle.

---

## Revoking a peer

Either side can revoke at any time.

1. Open **Admin → Federation → Peers**.
2. Find the peer entry (status: `peered`).
3. Click **Revoke**.

On revocation:

- The peer's `RemoteInstance` row is marked `revoked` on the local instance.
- A `FEDERATION_PEER_REMOVED` event is broadcast to local clients so open sessions
  update immediately.
- The remote instance is notified and marks the local instance `revoked` on its side.
- Cached `RemoteUser` records associated with that peer are hard-deleted.
- Federated content already in the local database is marked hidden (not deleted —
  Phase 1 has no content, so this only matters from Phase 3 onward).

**There is no "un-revoke".** If you want to reconnect, start the handshake over from scratch.

---

## What is irreversible (Phase 1)

Phase 1 is the safest phase: **nothing irreversible happens**. No content leaves the
instance. Revoking a peer returns both sides to a clean state with no data exposure
beyond:

- The existence of your instance and its public key (revealed during discovery).
- The fact that the two operators attempted to peer (logged in `FederationEnvelopeLog`).

Phases 3 and beyond put content on the wire. Once a message has been delivered to a peer,
the peer has a copy. Revoking the peering hides the content locally but cannot erase
copies already received by the peer. Plan accordingly before enabling Phase 3+.

---

## What the operator must understand before flipping the switch

Adapted from `docs/federation.md` §Privacy & threat model:

**What leaks across the boundary (Phase 3+, not Phase 1):**
- Any message posted in a federated channel.
- The fact that a user exists, their display name, avatar, presence, and custom status
  (subject to capability opt-in).
- Tavern metadata for federated Taverns: name, icon, and channel list (but not
  non-federated channels).

**What never leaks:**
- Local-only channels, even inside a federated Tavern.
- Local-only Taverns on a federated instance.
- Notes, handouts, GM-only campaign data — unless explicitly federated.
- Read state, drafts, notification preferences.
- IP addresses (envelopes carry instance identity, not user IP).

**Trust model:**
- Federation is opt-in per pair, not promiscuous. You choose every peer.
- Trust extends to the **peer instance's operators**, not just its users. If you trust
  `b.example.com`, you trust whoever runs `b.example.com` with the data you send them.
- A peer's moderation policy may not match yours.
- Trust does not transit: if A peers with B and B peers with C, A and C do not federate.

**Before enabling federation on a Tavern (Phase 4+):**
- Once content is federated, it cannot be retroactively un-shared. Tombstoning works for
  moderation, but peers may already have cached copies.
- Inform your community members that content in federated channels may leave the instance.

---

## Local verification with the docker-compose testbed

The testbed in `infra/docker/` boots two Tavern instances on a shared bridge network
behind Caddy with a local CA, so HTTPS works without modifying your system trust store.

Quick start:

```bash
# 1. Generate certs and env vars (one-time).
./infra/docker/federation/gen-certs.sh

# 2. Export the printed keys.
export TAVERN_DATA_KEY_A="<value from gen-certs.sh>"
export TAVERN_DATA_KEY_B="<value from gen-certs.sh>"

# 3. Add hosts (Linux/macOS — run as root or with sudo).
echo "127.0.0.1 a.tavern.local b.tavern.local" >> /etc/hosts

# 4. Boot.
docker compose -f infra/docker/docker-compose.federation.yml up -d

# 5. Walk through the peering handshake as described above.
#    a.tavern.local → Admin → Federation → Peers → Add peer → b.tavern.local
#    b.tavern.local → Admin → Federation → Peers → Approve

# 6. Tear down when done.
docker compose -f infra/docker/docker-compose.federation.yml down -v
```

The testbed is also used by the (currently stubbed) E2E suite:

```bash
FEDERATION_E2E=1 pnpm test:e2e --grep "federation peering"
```

See `infra/docker/federation/README.md` for details.

---

## Phase 2: Remote-user identity

Phase 2 adds per-user signing keys and the first visible cross-instance feature: qualified
mentions and profile previews. No messages federate yet.

### What works now

Users can write `@alice@b.tavern.local` in any message. The mention renders as a styled pill
with a home-instance badge. Hovering the pill fetches Alice's display name and avatar from
`b.tavern.local` via a signed federation envelope. The result is cached for 1 hour in the
`RemoteUser` table; the next hover after expiry triggers a fresh fetch.

### What doesn't work yet

- **Messages don't federate** — the mention appears locally but nothing is sent to
  `b.tavern.local`. That's Phase 3.
- **No remote notification** — Alice's home instance is not told she was mentioned.
  Also Phase 3.
- **Remote users don't appear in member lists** — that requires the federated invite flow
  from Phase 4.
- **DMs to remote users aren't possible** — Phase 5.

### User keypairs

Every new local user gets an Ed25519 keypair at registration. The private half is encrypted
with `TAVERN_DATA_KEY` before storage. Pre-federation users (accounts created before Phase 2
was deployed) are lazy-backfilled: the first time a peer requests their profile, the API
generates and stores their keypair on the fly. No operator action is required — the backfill
is fully automatic.

### Cache TTL

`RemoteUser.lastSeenAt` is updated on every successful profile fetch. Any lookup that finds
`lastSeenAt` older than 1 hour re-fetches from the home instance before returning. If the
home instance is unreachable, the cached values are served stale with a warning in the
response envelope.

### Endpoints exposed

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /_federation/profile` | Envelope-authenticated (peer instance key) | Peer → this instance: resolve a local user's public profile |
| `GET /api/federation/users/:remoteUserId/profile` | Session (any logged-in user) | Browser → this instance: fetch a cached remote user profile for the hover card |

The `/_federation/profile` route is public in the sense that any peer with a valid signed
envelope can call it. It returns only non-sensitive fields: `displayName`, `avatarUrl`
(best-effort — see follow-up #7), `publicKey`, and `homeInstance`.

---

## Phase 3 — federated channel messages

Phase 3 puts message **content** on the wire. When a local user posts a message
in a federated room of a federated den, the message is signed and POSTed to
every peered instance that has at least one remote member of that den. The
receiving instance verifies the two-layer signature (user + instance key),
persists the message locally, and broadcasts it to its own clients.

### What flows

- **Message create**: messages posted in a federated room reach peers with a
  remote member of the den.
- **Message edits**: only the original author's edits federate. Moderator edits
  are deferred to Phase 7.
- **Message deletes**: only the original author's deletes federate. Moderator
  deletes are local-only until Phase 7's "remove globally" feature.
- **Reactions add/remove**: unicode reactions federate. Custom emoji do not
  cross instances yet — see follow-up #15.

### What does NOT yet federate (Phase 4+ work)

- **Invites and Tavern joins** — Phase 4.
- **Direct messages** — Phase 5.
- **Presence / custom status** — Phase 6.
- **Moderation actions (bans, "remove globally" deletes)** — Phase 7.
- **Voice / video** — Phase 8 (V2).
- **Custom emoji content** — follow-up #15.
- **Avatar bytes** — peers fetch via the URL the home instance publishes;
  there is no avatar mirroring yet (follow-up #7).

### Opt-in surface

Both flags must be on for messages to leave the instance:

1. **`FEDERATION_ENABLED=true`** at the instance level (env var).
2. **Den-level**: `Server.federationEnabled = true`. Set via the den's settings
   page → Federation tab (admins only). Defaults to off.
3. **Per-room override** (optional): `Channel.federationMode` is `inherit`
   (default — follow the den), `force_on` (override the den's off), or
   `force_off` (override the den's on). Set via the room's settings popover.

A non-federated den on a federated instance behaves identically to a den on a
non-federated instance.

### Transport

For Phase 3, federated events use **HTTPS POST** to the peer's
`/_federation/event` endpoint. The `.well-known/tavern-federation` discovery
doc advertises a `wss://` endpoints.events URL but it is **not used yet** —
WSS server-to-server transport is a Phase 5+ optimization. HTTPS POST is
sufficient for Phase 3 message volume and keeps the dispatch path strictly
request/response.

### Manual remote-member addition (testing backdoor)

Phase 3 ships before the federated-invite flow (Phase 4), so adding a remote
user to a den is currently a manual operation:

```
POST /api/admin/servers/:id/remote-members
Body: { "remoteUserId": "alice@b.example" }
Auth: Instance admin
```

The endpoint resolves the remote user's profile from their home instance,
creates the local User mirror row (with no password), and creates a
ServerMember row in the target den with the default role.

This endpoint exists ONLY to exercise Phase 3 end-to-end before Phase 4 ships.
Once Phase 4 lands, the proper invite flow replaces it. Treat it as an
admin-only testing tool, not a production user-management surface.

### Reversibility

Phase 3 is the first phase that is not trivially reversible. Once a message
envelope has been POSTed to a peer, the peer has a copy of the content. A
local message delete will federate (author-only). To stop federating an
already-running den:

1. Turn `Server.federationEnabled=false` in den settings. New messages no
   longer fan out.
2. Existing messages already on peers cannot be unsent. Phase 7 will add
   a "remove globally" moderation action.
3. For a hard cut-off, revoke the peer at the admin UI — that stops all
   future envelopes in both directions, but does not retroactively delete
   anything from the peer's database.

### Outbox + retry

Federated events go through a BullMQ-backed outbox queue
(`tavern.federation.outbox`). The worker process consumes the queue, builds
the two-layer envelope, and POSTs to the peer. Failures retry 3× with
exponential backoff (5s base). Permanent failures are logged at error level
and remain in the BullMQ `failed` ring (default 1000 entries) for
post-mortem inspection. In single-replica deployments (no `REDIS_URL`), the
outbox runs in-process via `setImmediate` with no retry — failures log and
move on.

---

## Phase 4 — federated invites and Tavern mirroring

Phase 4 lets a user on one instance join a Tavern hosted on another. The
joining instance maintains a **mirror** of the home Tavern's server, channels,
and member roster, all kept in sync via federation envelopes.

### Creating a federated invite

In the den's settings → Invites tab, when creating an invite for a federated
den (one with `federationEnabled=true`), the invite form gains three federated
scope options:

- **Any peer**: any user on any peered instance can use this invite.
- **Specific instance**: only users on the chosen peer can use it.
- **Specific user**: a named qualified id (alice@b.example) can use it.

The federated invite URL looks like `https://your-tavern.example/invites/{code}?host={your-tavern.example}`.
Send the link to the joiner via any out-of-band channel (DM, paste in a chat).

### The joiner's flow

When the joiner pastes the invite link into their instance's UI:

1. The browser hits `GET /api/federation/invite-preview?host={host}&code={code}` on the joiner's
   API. The API proxies to the home instance's public preview endpoint with the joiner's
   instance + user identity in headers.
2. A modal shows the invite preview (host, server name, inviter, channel count).
3. On accept, the browser hits `POST /api/federation/invites/{code}/accept` on the joiner's API.
   The API:
   - Builds a signed `member.join_request` envelope.
   - Synchronously POSTs to the home's `/_federation/event` endpoint.
   - Receives a `member.joined` ack with a snapshot of the den (metadata, channels, members).
   - Mirrors the den locally in a single transaction: creates a mirror Server with
     `originInstanceId` set, creates mirror Channels, creates ServerMember rows for the joiner
     and all current members.
   - Publishes `SERVER_ADD` to the joiner's gateway connection so their UI live-updates.

### Live sync — what flows

After the mirror is set up, the home instance pushes updates to the joining instance via
federation envelopes:

| Event | When | Inbound effect on the mirror |
|-------|------|-----------------------------|
| `server.update` | Den name/description/icon changed | Mirror Server row updated + SERVER_UPDATE broadcast |
| `channel.create` | New room added | Mirror Channel inserted + CHANNEL_CREATE broadcast |
| `channel.update` | Room renamed, topic changed, federationMode flipped | Mirror Channel updated + CHANNEL_UPDATE broadcast |
| `channel.delete` | Room deleted | Mirror Channel deleted + CHANNEL_DELETE broadcast |
| `member.add` | New member joined the home Tavern | Mirror member roster grows |
| `member.remove` | Member kicked / banned / left | Mirror member roster shrinks |

### What does NOT flow yet

- **Roles**: every member of a mirror den has a single synthetic `@everyone` role with
  `PERMISSION_DEFAULT_EVERYONE`. Per-Tavern roles do not federate — "trust does not transit".
  Phase 7 will revisit moderation roles.
- **Custom emoji**: still follow-up #15.
- **Avatar bytes**: the home's URLs are referenced; no mirroring of attachment data.
- **Voice / stage / category channels**: mirrors only carry text and forum rooms.
- **Invite revocation**: revoking an invite on the home does not push to peers; in-flight
  accepts will fail at the home's check.

### Home-instance message relay

When a user on a peer (B) posts a message in a mirror channel, the message flows to the home
(A) via the regular outbox. A persists it with `originInstanceId = B`, then **relays** it to
every OTHER peer with members in the channel. The relay envelope preserves the original user
signature so the receiving peer can verify the author against B's profile — but the outer
envelope is signed by A.

This means: A is the choke point. If A is down, federated chat in T stops for all peers.

### Leaving a federated den

The joiner clicks "Leave this den" in the Federation tab of the mirror's settings. The browser
hits `POST /api/federation/mirror-servers/{id}/leave`:

1. The leaver's API builds a signed `member.leave` envelope.
2. Synchronously POSTs to the home.
3. Receives `member.removed` ack.
4. Deletes the local ServerMember row. If no local members remain, the mirror Server is torn
   down (cascades channels and the synthetic role).
5. Publishes `SERVER_REMOVE` to the user's gateway connection.

### Admin remote-member endpoint (Phase 3 carryover)

The Phase 3 `POST /api/admin/servers/:id/remote-members` endpoint still exists and bypasses
the invite flow. Use it for testing or to add a remote member without an invite ceremony. The
same membership envelopes fire afterward.

---

## Phase 5 — federated 1:1 direct messages

Phase 5 lets users on different instances exchange direct messages. Both peers
must advertise the `dms` capability for federation to engage; instances may
opt out via `FEDERATION_DMS_ENABLED=false`.

### How federated DMs work

A 1:1 DM between alice@a.example and bob@b.example is **mirrored on both
instances** — each side stores its own DmChannel and Message rows. Messages
typed on either side cross to the other via signed envelopes.

- **Identifier**: both instances use the SAME `DmChannel.id` (a global ULID).
  The originating instance picks it; the receiver accepts it.
- **PairKey**: sorted qualified ids form (`alice@a.example:bob@b.example`).
  Local DMs continue using local-id pairKeys; both formats fit the `@unique`
  constraint.
- **Storage**: each instance has its own DmChannel + DmChannelMember rows
  (one local user, one remote-user mirror) and its own Message rows.

### Capability gate

Both peers must list `dms` in their `.well-known/tavern-federation`
capabilities. The peering handshake intersects the two lists; if either side
has DMs disabled, the resulting `RemoteInstance.capabilities` on both sides
will not include `dms`, and all DM federation operations short-circuit.

To disable DM federation on a specific instance, set
`FEDERATION_DMS_ENABLED=false` in `.env`. The instance:
- Drops `dms` from the well-known advertisement.
- Rejects all inbound `dm.*` events with 403 `dms_capability_missing`.
- Skips all outbound DM fan-out at the route level.

Existing federated DMs persist locally on each instance but stop syncing.

### Starting a federated DM

The initiator's UI calls `POST /api/dms/direct` with the recipient's local
user id (which is the recipient's mirror User row on the initiator's
instance — created earlier via federated Tavern membership). The route:

1. Resolves both users via Prisma.
2. Verifies the share-server gate — the initiator and recipient must share at
   least one server (local or federated mirror).
3. Computes the qualified-id pairKey.
4. Creates the DmChannel locally via `findOrCreateDirectDm` (idempotent on
   pairKey UNIQUE).
5. Fans out `dm.create` to the recipient's home instance.

The receiving instance's inbound handler:
1. Verifies the peer advertises `dms`.
2. Resolves the recipient as a local user.
3. Ensures the initiator's mirror User row exists.
4. Creates the matching DmChannel with the SAME id.
5. Broadcasts DM_CHANNEL_CREATE to the recipient's gateway.

### What propagates

| Event | When |
|-------|------|
| `dm.create` | Initiator opens a DM with a remote user |
| `dm.message.create` | Message posted in a federated DM |
| `dm.message.update` | Message edited (author only) |
| `dm.message.delete` | Message deleted (author only) |
| `dm.reaction.add` | Reaction added |
| `dm.reaction.remove` | Reaction removed |

### What stays local

- **Read state** (`DmChannelMember.lastReadAt`).
- **Drafts** (browser-local).
- **Notification settings**.
- **Typing indicators**.
- **Group DMs** (Phase 5 covers 1:1 only — group DM federation is deferred).

### Out-of-order delivery

If a `dm.message.create` arrives before the `dm.create` for that channel, the
receiver returns 404 `unknown_dm_channel`. The outbox retries the message
envelope until the dm.create lands. This is rare in practice — `dm.create`
fires synchronously before any messages can be posted — but the retry
handles edge cases like dropped connections during initial DM setup.

### Privacy considerations

Federated DMs leak the same metadata as federated channel messages:
- The peer instance learns who you're talking to and the message content.
- Operators of both instances can read DM messages in their database.
- This is by design — federation IS the leak. Users who require strict
  locality should pick an instance that disables `dms`.
- End-to-end encryption is deferred to Phase 8+.

---

## Phase 6 — federated presence and custom status

Phase 6 puts user presence and custom status on the wire. When a local user
transitions between `active` / `idle` / `dnd` / `offline`, or sets / clears
their custom status, the change propagates to peers that share at least one
federated Tavern or DM with that user. The peer's UI updates live — presence
dot, hover card, member list, and DM list.

### How presence federates

- **Home instance is authoritative.** A user's home is the only instance that
  emits presence envelopes for that user. Peers receiving an envelope from any
  instance other than the user's home are rejected with 403 `not_home_instance`.
- **Single envelope kind: `presence.update`.** Carries the user's effective
  `presence`, optional `customStatus` string + `customStatusExpiresAt` ISO
  timestamp, and the home's `updatedAt` watermark for last-write-wins on the
  receiver.
- **Single-layer signing (instance only).** Unlike message envelopes, presence
  is not user-authored content — it's the home instance reporting what it
  currently knows about its user. The envelope is signed with the instance
  key only; no user-layer signature.
- **Fan-out scope.** When a local user's presence or custom status changes, the
  presence service queries for peers where the user shares ≥ 1 federated
  Tavern OR federated DM. Peers with zero shared surfaces are not notified.
- **Last-write-wins.** The receiver compares the envelope's `updatedAt` to
  the existing `User.presenceUpdatedAt` watermark and drops stale envelopes
  silently (out-of-order delivery is possible with BullMQ retries).

### The `presence` capability gate

The `presence` capability is negotiated at peering. Each side advertises it in
`.well-known/tavern-federation`; the handshake intersects the two lists and
stores the result on `RemoteInstance.capabilities`. Both ends must advertise
`presence` for the capability to be active for the pair.

If `presence` is missing from a peer's stored capability set, the outbound
fan-out short-circuits before enqueue (no envelope is sent to that peer) and
the inbound handler returns 403 `presence_capability_missing` if invoked.

### `FEDERATION_PRESENCE_ENABLED`

Controls whether this instance participates in presence federation. Default
`true`. Behaviour matches `FEDERATION_DMS_ENABLED`:

| Value | Effect |
|-------|--------|
| `true` (default) | The instance advertises `presence` in `.well-known/tavern-federation`. Outbound presence fan-out is active; inbound `presence.update` envelopes are accepted. |
| `false` | The instance drops `presence` from the well-known advertisement. Outbound fan-out short-circuits before enqueue. Inbound `presence.update` envelopes are rejected with 403 `presence_capability_missing`. |

Existing federated presence state persists locally on each side but stops
updating.

### Custom status mechanics

Set / clear via `PATCH /api/me/presence` with the body:

```json
{
  "customStatus": "🎲 In a session, back at 9pm",
  "customStatusExpiresAt": "2026-05-21T21:00:00Z"
}
```

- `customStatus`: string, **max 128 chars**. `null` clears the status (and the
  expiry).
- `customStatusExpiresAt`: ISO datetime, nullable. **Past-expiry values are
  rejected 400** (`custom_status_expires_in_past`) — clients must compute the
  expiry server-side or validate before posting. The receiver respects the
  same wall-clock expiry; no clock-skew handling is applied beyond the
  watermark.
- Once set, the custom status is included in the next `presence.update`
  envelope emitted for that user. Custom-status changes always fire fan-out
  immediately (they bypass the 5-second debounce — see below).

Custom status on a remote-user mirror is overwritten by inbound envelopes
only. The local `PATCH /api/me/presence` route only operates on the
logged-in user's own row, which is always local.

### 5-second debounce on active⇄idle / DND flaps

Presence transitions flap frequently — a user toggling tab focus generates
multiple `active`⇄`idle` transitions in seconds. To avoid thrashing the
outbox, presence fan-out passes through a per-user 5-second debounce window
that emits the LAST observed state for that user at the end of the window.

**Exceptions that bypass the debounce and fire immediately:**

- Transitions to `offline` (rare, noteworthy — peers should see them now,
  not after a 5-second wait).
- Custom-status set / clear operations.

The debounce only buffers `active`⇄`idle` flips and manual DND toggles.
Local gateway broadcast (to the user's own browser tabs and other local
clients) is always synchronous — the debounce affects federation fan-out
only.

### What stays local

The following are **not** federated by Phase 6:

- **Typing indicators** — local-only by design (high-frequency, low-value
  cross-instance).
- **Read state** (`DmChannelMember.lastReadAt`, channel last-read marks).
- **Drafts** (browser-local).
- **Notification preferences** — per-user and per-Tavern notification config
  never leaves the instance.

These match the locality stance from Phase 5 DMs: the federated content is
the user-visible "what's happening" surface; the UX state around it is
local.

### Live custom-status broadcast (PRESENCE_UPDATE)

`PRESENCE_UPDATE` WebSocket events now carry `customStatus` and
`customStatusExpiresAt` alongside the presence dot. When a user's custom
status changes — locally via `PATCH /api/me/presence` OR via a federated
`presence.update` mirror write — every client subscribed to that user's
presence updates the pill live without a profile re-fetch. Both fields are
optional on the payload: emitters that aren't touching custom status (e.g.
the idle scanner) omit them, and receivers treat absent as "no change" so
the existing presence-only broadcast path doesn't clobber the custom-status
store. Expiry is wall-clock-evaluated on the receiver — same model the
profile-fetch path uses.

Closed follow-up #32; see PF-2 in the federation-polish batch.

### Privacy considerations

Federated presence leaks online/offline patterns and custom-status content
to every peer the user shares a federated surface with. This is by design —
federation IS the leak. Mitigations:

- Operators who want strict locality can set `FEDERATION_PRESENCE_ENABLED=false`
  without affecting messaging or DMs.
- The `presence` capability is opt-in per instance.
- Individual users can opt out of presence federation without operator
  action — see §Per-user federation privacy below.

---

## Per-user federation privacy

Phase 6 wrapped the instance-level federation gates (`FEDERATION_DMS_ENABLED`,
`FEDERATION_PRESENCE_ENABLED`, plus per-Tavern / per-room opt-in). The
federation-polish batch added two **per-user** toggles on top, so individual
users can refuse federation features even when their instance advertises
them. Both default to opt-in (existing behaviour pre-migration).

### The two toggles

Users find them at **Account settings → Federation privacy** (the card is
hidden entirely on instances that don't advertise either of the
corresponding capabilities). Each row is rendered only when the
corresponding capability is currently advertised — there's no value in
showing "share my presence with federated peers" on an instance where the
operator has set `FEDERATION_PRESENCE_ENABLED=false`.

| Toggle | Column | Default | Effect |
|--------|--------|---------|--------|
| Share my presence with federated peers | `User.acceptsFederatedPresence` | `true` | When off: presence + custom-status changes still broadcast to LOCAL clients (own tabs, local members), but no `presence.update` envelope is enqueued to any peer. |
| Accept new direct messages from federated peers | `User.acceptsFederatedDms` | `true` | When off: inbound `dm.create` envelopes targeting this user are rejected at the home instance with 403 `recipient_refuses_federated_dms`. |

Both columns live on the `User` table with default `true`, so the migration
preserves existing behaviour. Operators who want to mass-flip the defaults
(e.g. a private instance that opts every user out of federation by default)
can run a one-shot SQL update:

```sql
UPDATE "User" SET "acceptsFederatedPresence" = false WHERE "remoteInstanceId" IS NULL;
UPDATE "User" SET "acceptsFederatedDms" = false WHERE "remoteInstanceId" IS NULL;
```

The `remoteInstanceId IS NULL` filter restricts the flip to LOCAL users —
remote-user mirror rows shouldn't have either flag touched.

### Asymmetric semantics

The two toggles guard their respective features differently:

- **Presence is OUTBOUND ONLY.** A user can only refuse to have THEIR
  presence broadcast. There's no "I refuse to see remote users' presence"
  gate — peers send presence envelopes for their own users, not at me, and
  filtering inbound presence would just leave the UI showing stale
  "offline" dots for users who are in fact active. When alice has
  `acceptsFederatedPresence=false`, the fan-out path at her instance
  short-circuits before enqueue (logged as `federation presence fan-out
  skipped — user has acceptsFederatedPresence=false`) and peers simply
  receive nothing for her. They keep showing whatever state they last
  saw (typically the offline dot from her last cycle).
- **DMs are gated in BOTH directions.** The teeth are on the receiver side:
  the home instance's `dm.create` handler reads the local recipient's
  `acceptsFederatedDms` and rejects with 403 `recipient_refuses_federated_dms`
  when false. The initiator side surfaces that rejection cleanly through
  the `POST /api/dms/direct` route so the UI can render a specific error.
  There's no peer-discovery for the recipient's preference ahead of time —
  the initiator finds out at create-time when the synchronous federated
  POST returns 403.

### "Already-open federated DMs stay open"

The DM gate fires at `dm.create` only. Once a federated DmChannel exists,
subsequent `dm.message.*` envelopes for that DM pass through normally —
flipping `acceptsFederatedDms` to false does NOT close existing federated
DMs. The opt-out semantic is "don't let NEW federated DMs land in my
inbox," not "sever federation on every DM I already had." Closing an
existing federated DM unilaterally is a moderation action and is deferred
to Phase 7.

If a user wants to stop receiving messages from a specific existing
federated DM, the current options are the local mute / leave actions on
that DM — both stay local to the user's instance.

### The `recipient_refuses_federated_dms` 403 code

A new entry in the inbound-error discriminated union and the route's
`statusForCode` switch:

- **Where it surfaces:** the receiver's `/_federation/event` route returns
  HTTP 403 with `{ error: 'recipient_refuses_federated_dms' }` when an
  inbound `dm.create` targets a local user whose `acceptsFederatedDms` is
  false.
- **What operators see in logs:** the initiator's outbound dispatcher
  converts the 403 into a `FederationOutboxPermanentError` (no retry — the
  preference is sticky, not transient) and dead-letters the job into
  BullMQ's `failed` ring. Operators inspecting outbox failures will see
  a permanent-error entry with the recipient's qualified id; this is
  expected behaviour, not a bug. The initiator's `POST /api/dms/direct`
  route also surfaces a user-facing error to the originating browser so
  the UI can render an explanation.
- **Known operational gap:** there is no admin UI for inspecting or
  retrying dead-letter jobs today — see follow-up #16. Operators have to
  shell into Redis (or use a separate BullMQ dashboard) to enumerate
  federation failures. The dead-letter UI is on the roadmap; until then,
  these permanent-error entries are visible but not actionable from the
  admin surface.

The 403 code is symmetric with the existing `dms_capability_missing` 403
(instance-level gate) — both are permanent, both dead-letter immediately
on the initiator, neither retries.

---

## Upgrading from pre-Phase-5

The `20260522090000_reset_pre_phase5_peer_capabilities` migration resets the
`capabilities` column on any `peered` RemoteInstance rows that lack the full
`messages + dms + presence` capability set. This affects peers that were
established before Phase 5's capability intersection enforcement.

After applying migrations, affected peers will lose DM and presence capability
until the next re-handshake. Operators can trigger this manually via the admin
UI ("Re-initiate peering") or wait for the next outbound federation event to
prompt an automatic re-handshake.
