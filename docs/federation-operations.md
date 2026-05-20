# Federation operations guide

Phases 1–3 of Tavern federation are now in place: peering, remote-user identity, and
channel-message federation (create / edit / delete / reactions). Federated invites, DMs,
presence, and moderation propagation are still pending. Operators can safely enable peering,
exchange channel messages with peered instances at the per-Tavern and per-channel opt-in
level, and verify everything via the admin UI.

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
enables the peering handshake (Phase 1). Content federation (Phase 3+) requires additional
per-Tavern and per-channel opt-in settings that do not exist yet.

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
