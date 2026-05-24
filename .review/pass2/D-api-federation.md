# Track D — API: Federation Services

## Critical / High

**[BUG/SEC] Cross-peer envelope origin is never verified at the HTTP layer.** `apps/api/src/services/federation-inbound.ts:326–342`. The peer lookup at `processEnvelope` is keyed on `fromInstance` (the envelope's signed origin header). The signature check verifies the instance signature against the key stored on the `RemoteInstance` row for that host — correct. However, there is no assertion that the HTTP request was physically received FROM that peer's network identity (TLS cert / SNI). A peer can craft an envelope where `fromInstance = "a.example"` and deliver it over a connection from `b.example`. The receiver's replay log records the nonce against `a.example`'s peer id, burning a slot. The relay path (P4-13) makes this worse. The forgery itself is blocked (requires private key) but the threat model needs documentation, and ideally the HTTP layer should bind the caller's identity.

**[BUG] `MAX_CLOCK_SKEW_MS` guard missing on `createdAt` in `handleMessageCreate` and `handleDmMessageCreate`.** `apps/api/src/services/federation-inbound.ts:1263, 3432`. `assertTimestampWithinSkew` is consistently applied to `editedAt` and `deletedAt` but the initial `createdAt` is used as `new Date(payload.createdAt)` with no skew check. A peer can legally sign a valid envelope whose `createdAt` is hours/days old (or future up to nonce expiry), allowing backdated messages. Fix: call `assertTimestampWithinSkew('createdAt', createdAt)` after constructing the Date.

**[BUG] `handlePresenceUpdate` host comparison is case-sensitive; DNS labels are case-insensitive.** `apps/api/src/services/federation-inbound.ts:4096`. `userHost !== peer.host` plain string equality. If sending peer uses different capitalisation (e.g. `A.Example` vs `a.example`), guard throws `not_home_instance` for a legitimate sender. Other comparisons (e.g. `dm.create` recipient host check at line 3141) normalise to lower-case. Fix: lowercase both sides.

**[BUG/SEC] Key rotation: `previousInstanceKey` never cleared or expired.** `packages/db/prisma/schema.prisma:2409`, `apps/api/src/services/federation-inbound.ts:519–528`. Column written at peering-accept (line 305 in federation-peering.ts) but no code path nullifies or time-bounds it. If a peer rotates KEY1→KEY2→KEY3, mid-chain KEY2 is unsigned. A stolen KEY1 remains a valid signing key indefinitely. Fix: add `previousInstanceKeyExpiresAt` timestamp; clear in dispatch path when past; write expiry at peering-accept.

**[BUG] `dm.create` 4xx from peer → permanent `UnrecoverableError` → `DM_CHANNEL_FEDERATION_REFUSED`.** `apps/worker/src/federation-outbox-worker.ts:99–111, 149–165`. Capability mismatch causing a transient 403 (peer rolling restart) is treated as a permanent failure — user is told their DM was refused, no retry. Consider retrying 403s from the `dms` capability gate at least once before dead-lettering.

**[BUG] Outbox FIFO is not per-peer: `CONCURRENCY=4` across all peers breaks causal ordering.** `apps/worker/src/federation-outbox-worker.ts:34,116`. `reaction.add` for a message can be dispatched first if J1 (message.create) waits to retry after 5xx and J2 (reaction.add) is fresh. Peer receives `reaction.add` for unknown message → 404 → `UnrecoverableError` → reaction permanently lost. Fix: enforce FIFO per-peer (per-peer Queue, or concurrency 1, or treat 404 reactions as retry-eligible).

## Medium

**[BUG] Dead-letter retention unbounded beyond ring limit.** `apps/api/src/services/queues.ts:250`. `removeOnFail: { count: 1000 }` keeps last 1000 failed jobs; admin UI reads up to 100. No background purge for old jobs. For a peered instance whose peer goes offline for an extended period, all outbound events accumulate up to ring limit then silently drop. Add `maxAge` env var, or document the ring behavior.

**[BUG] Soft-deleted local users never federated as leave events to peers.** `apps/api/src/routes/account.ts:265`. When a local user schedules deletion (`scheduledDeleteAt` set), no `member.leave` envelopes emitted to peered instances. Remote peers keep mirror `ServerMember` row indefinitely (zombie). Symmetric remote-user case is handled correctly. Fix: in account-deletion worker, enqueue `member.leave` per relevant peered instance.

**[BUG] Remote user zombie records: no cleanup when a `RemoteUser` stops sending.** `apps/api/src/services/federation-mirror.ts:33–36`. No sweep removes `RemoteUser` / synthetic `User` rows when a peer is revoked and the user has no remaining `ServerMember` / `DmChannelMember`. Storage grows unbounded; ULIDs make collision extremely unlikely, but the gap is real.

**[?] Capability removal while events in-flight — `messages` path not notified.** `apps/worker/src/federation-outbox-worker.ts`. `dm.create` exhaustion path notifies via `DM_CHANNEL_FEDERATION_REFUSED`. Peer removing `messages` capability → dispatcher drops queued `message.create` jobs silently (outbox-dispatcher.ts:142–148: `peer status !== 'peered' → drop`). Users authoring those messages get no signal.

**[DOC] `previousInstanceKey` overlap window undocumented and unconfigurable.** `packages/db/prisma/schema.prisma:2409`. Effectively infinite (until next rotation overwrites). No `FEDERATION_KEY_ROTATION_OVERLAP_SECONDS` env var, no `previousInstanceKeyExpiresAt` column. docs/federation.md:226 says "long-lived" without specifying overlap. Combined with the security gap above, both a doc gap and a security gap.

## Low / Nits

**[STYLE] `federation-inbound.ts` at 4362 lines should be split.** `apps/api/src/services/federation-inbound.ts:1`. 18+ handler functions plus dispatcher; group by event type (messages, reactions, members, mirror, dms, presence). Deferred per review scope.

**[DOC] `canonical-json.ts` key sort is JS `Array#sort` (UTF-16 code-unit order) — matches JCS spec but differs from Unicode code-point order for chars > U+FFFF.** `packages/federation/src/canonical-json.ts:37`. All envelope keys in practice are ASCII (identical under both orderings). Call out explicitly in spec docs.

**[DOC] `federation-client.ts:discoverInstance` does not call `assertValidPeerHost`.** `apps/api/src/services/federation-client.ts:15`. All callers do, but if a future code path skips the guard the SSRF protection disappears silently. Move `assertValidPeerHost` inside `discoverInstance`.

## Notes

- AES-GCM nonce uniqueness: correctly implemented. `randomBytes(NONCE_LEN)` fresh per `encryptAtRest`. Test at `apps/api/test/at-rest.test.ts:16–18` verifies different ciphertexts.
- SSRF guard URL re-encoding: invite-preview proxy at `routes/federation-invite-preview-proxy.ts:133` calls `assertValidPeerHost(host)` and uses `host` directly as a path component — no injection vector.
- Cross-peer replay via forwarded envelopes: `FederationEnvelopeLog @@unique([peerInstanceId, nonce])` blocks same-peer replay. Relay envelopes get fresh nonces.
- canonical-json + Unicode normalization: envelope values are ISO timestamps, ULIDs, ASCII strings. No NFC/NFD concern.
