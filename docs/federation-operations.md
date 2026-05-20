# Federation operations guide

Phase 1 of Tavern federation is the **peering handshake only**. No content (messages,
presence, invites, DMs) crosses the boundary yet. Operators can safely enable peering,
explore the admin UI, and verify connectivity without any user data leaving the instance.

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
