/**
 * Presence service.
 *
 * Owns the "user is active / idle / dnd / offline" state. Sources:
 *   - Gateway socket lifecycle (markConnected on IDENTIFY, markDisconnected
 *     when the last socket closes) — handles `offline` and the initial
 *     online transition.
 *   - Client reports via PATCH /api/me/presence — handles idle/active
 *     transitions (the client knows when its window has gone idle) and the
 *     manual DND override.
 *
 * Effective presence is derived from two inputs:
 *   - `clientActive`: whether the client most recently reported being active.
 *     Only meaningful while at least one socket is open.
 *   - `manualDnd`: the sticky DND override, persisted on the user row.
 *
 * Rules:
 *   - All sockets closed → `offline`
 *   - At least one socket open AND manualDnd → `dnd`
 *   - At least one socket open AND clientActive → `active`
 *   - At least one socket open AND !clientActive → `idle`
 *
 * `clientActive` lives in-memory only — we don't persist it. If the server
 * restarts mid-session, presence resets to the user's last persisted state
 * and corrects on the next heartbeat.
 *
 * --- Federation (P6-6) ----------------------------------------------------
 *
 * When `configurePresenceFederation` has been called at app startup,
 * `persistAndBroadcast` schedules a federation fan-out alongside the local
 * gateway broadcast. The fan-out is debounced per-user for 5s so active⇄idle
 * flaps don't thrash the outbox queue. The exception is offline transitions
 * (and custom-status changes in P6-8): those fire IMMEDIATELY because they're
 * rare and important.
 *
 * Federation deps are wired via a setter rather than a constructor argument
 * because the presence-service module is imported by route handlers that
 * land before app.ts has booted the federation block. Keep the
 * single-process state in this file — the debounce map is per-process.
 */

import { prisma } from '@tavern/db';
import type { Presence } from '@tavern/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { gatewayBroker } from './gateway-broker.js';
import type { QueueClient } from './queues.js';
import { fanOutPresenceUpdate } from './federation-outbox.js';
import { findPresenceFanOutPeers } from './federation-presence-targets.js';

const clientActiveByUser = new Map<string, boolean>();
const openSocketsByUser = new Map<string, number>();

// --- Federation wiring -----------------------------------------------------

interface FederationDeps {
  queues: QueueClient;
  selfHost: string;
  federationPresenceEnabledOnInstance: boolean;
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

let federationDeps: FederationDeps | null = null;

/**
 * Called once at app startup by `app.ts` after the federation block has
 * bootstrapped. Subsequent presence transitions will schedule a fan-out
 * for federation peers that share a surface with the user.
 *
 * Pass `null` to fully disable fan-out (used by tests + the federation-off
 * boot path).
 */
export function configurePresenceFederation(deps: FederationDeps | null): void {
  federationDeps = deps;
}

/** Per-user debounce timer for active⇄idle/dnd flaps. Offline fires immediately. */
const debouncedFanOut = new Map<string, NodeJS.Timeout>();

const FAN_OUT_DEBOUNCE_MS = 5_000;

/**
 * Schedule a federation fan-out for `userId`. When `immediate` is true,
 * fire now (offline transitions, custom-status changes). Otherwise coalesce
 * with any pending timer in the 5s window so a burst of active⇄idle flaps
 * emits a single envelope at the window's end with the LATEST state.
 *
 * No-op when federation is not configured.
 */
export function scheduleFanOut(userId: string, immediate: boolean): void {
  if (!federationDeps) return;
  if (immediate) {
    // Cancel any pending debounced fan-out; the immediate path supersedes it.
    const pending = debouncedFanOut.get(userId);
    if (pending) {
      clearTimeout(pending);
      debouncedFanOut.delete(userId);
    }
    void emitFanOut(userId);
    return;
  }
  if (debouncedFanOut.has(userId)) return; // a fan-out is already scheduled
  const handle = setTimeout(() => {
    debouncedFanOut.delete(userId);
    void emitFanOut(userId);
  }, FAN_OUT_DEBOUNCE_MS);
  debouncedFanOut.set(userId, handle);
}

/**
 * Read the user's CURRENT state from Postgres and dispatch a presence.update
 * envelope to every peer that shares a federated surface with them. Skips:
 *   - federation not configured (no-op).
 *   - user row not found (defensive).
 *   - user is a remote-user mirror (`remoteInstanceId != null`) — only the
 *     home instance authoritatively reports its own users' presence.
 *
 * All errors caught + logged. Federation failures MUST NOT bubble into the
 * local presence write path.
 */
async function emitFanOut(userId: string): Promise<void> {
  if (!federationDeps) return;
  const deps = federationDeps;
  try {
    const user = await deps.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        remoteInstanceId: true,
        presence: true,
        presenceUpdatedAt: true,
        customStatus: true,
        customStatusExpiresAt: true,
        acceptsFederatedPresence: true,
      },
    });
    if (!user) return;
    // Home-only fan-out: a mirror's presence is asserted by its home, not by us.
    if (user.remoteInstanceId !== null) return;
    // Per-user opt-out (PF-3 / follow-up #33). The read is in the same SELECT
    // as the mirror check above, so flipping the pref mid-debounce-window is
    // race-safe: by the time the debounced timer flushes and re-enters this
    // function, the fresh row is read and the new value is honoured. The
    // local broadcast in `persistAndBroadcast` is unaffected — only the
    // federation envelope is suppressed.
    if (!user.acceptsFederatedPresence) {
      deps.log.warn(
        { userId },
        'federation presence fan-out skipped — user has acceptsFederatedPresence=false',
      );
      return;
    }

    const peers = await findPresenceFanOutPeers(deps.prisma, userId);
    if (peers.length === 0) return;

    const userRemoteUserId = `${user.username}@${deps.selfHost}`;
    for (const peer of peers) {
      try {
        await fanOutPresenceUpdate({
          queues: deps.queues,
          selfHost: deps.selfHost,
          log: deps.log,
          federationPresenceEnabledOnInstance: deps.federationPresenceEnabledOnInstance,
          peerInstanceId: peer.peerInstanceId,
          peerHost: peer.host,
          userRemoteUserId,
          presence: user.presence as 'active' | 'idle' | 'dnd' | 'offline',
          customStatus: user.customStatus,
          customStatusExpiresAt: user.customStatusExpiresAt,
          updatedAt: user.presenceUpdatedAt,
        });
      } catch (err: unknown) {
        deps.log.warn(
          { err, userId, peerInstanceId: peer.peerInstanceId },
          'federation presence fan-out failed for peer',
        );
      }
    }
  } catch (err: unknown) {
    deps.log.warn({ err, userId }, 'federation presence fan-out failed');
  }
}

// --- Local presence -------------------------------------------------------

/**
 * Snapshot of every field PRESENCE_UPDATE carries on the wire. The
 * `broadcast` helper takes this whole shape so a single fan-out emits both
 * the live presence dot AND the live custom-status pill — receivers diff
 * against their store and only re-render on actual changes. See follow-up
 * #32 / PF-2.
 *
 * `customStatus` carries a SERIALISED ISO string for the expiry so the wire
 * payload matches `presenceUpdatePayloadSchema` (which requires
 * `customStatusExpiresAt: string().datetime().nullable().optional()`). The
 * service-internal callers hold a `Date` and convert here so the broadcast
 * site stays a one-liner.
 */
interface PresenceSnapshot {
  presence: Presence;
  customStatus: string | null;
  customStatusExpiresAt: Date | null;
}

function broadcast(userId: string, snapshot: PresenceSnapshot): void {
  gatewayBroker.publish({
    type: 'PRESENCE_UPDATE',
    userId,
    data: {
      userId,
      presence: snapshot.presence,
      customStatus: snapshot.customStatus,
      customStatusExpiresAt:
        snapshot.customStatusExpiresAt === null
          ? null
          : snapshot.customStatusExpiresAt.toISOString(),
    },
  });
}

function compute(userId: string, manualDnd: boolean): Presence {
  const open = (openSocketsByUser.get(userId) ?? 0) > 0;
  if (!open) return 'offline';
  if (manualDnd) return 'dnd';
  const active = clientActiveByUser.get(userId) ?? true;
  return active ? 'active' : 'idle';
}

async function persistAndBroadcast(userId: string, next: Presence): Promise<void> {
  // Single read pulls presence (for the no-op short-circuit) AND the custom
  // status fields that the broadcast now carries. Reading them here means
  // every PRESENCE_UPDATE we publish reflects the LIVE custom-status — a
  // receiver that joined the gateway after the status was set still gets
  // the up-to-date pill on the next presence flap. PF-2 / follow-up #32.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      presence: true,
      customStatus: true,
      customStatusExpiresAt: true,
    },
  });
  if (!row) return;
  if (row.presence === next) return;
  await prisma.user.update({
    where: { id: userId },
    data: { presence: next, presenceUpdatedAt: new Date() },
  });
  broadcast(userId, {
    presence: next,
    customStatus: row.customStatus,
    customStatusExpiresAt: row.customStatusExpiresAt,
  });
  // Federation fan-out: offline transitions fire immediately; active⇄idle
  // and dnd flaps go through the 5s debounce so we don't thrash the outbox.
  scheduleFanOut(userId, next === 'offline');
}

/**
 * Mark that the user has a live gateway socket. Idempotent over multiple
 * concurrent connections — the user is online while any socket is open.
 */
export async function markConnected(userId: string): Promise<void> {
  const prev = openSocketsByUser.get(userId) ?? 0;
  openSocketsByUser.set(userId, prev + 1);
  // Default to "active" on connect — the client will downgrade to idle
  // via the activity report if it boots up already idle.
  if (!clientActiveByUser.has(userId)) {
    clientActiveByUser.set(userId, true);
  }
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { manualDnd: true },
  });
  if (!row) return;
  await persistAndBroadcast(userId, compute(userId, row.manualDnd));
}

/**
 * Mark a socket as closed. When the count hits zero, the user flips to
 * `offline` and the in-memory active flag is cleared.
 */
export async function markDisconnected(userId: string): Promise<void> {
  const prev = openSocketsByUser.get(userId) ?? 0;
  const next = Math.max(0, prev - 1);
  if (next === 0) {
    openSocketsByUser.delete(userId);
    clientActiveByUser.delete(userId);
    await persistAndBroadcast(userId, 'offline');
  } else {
    openSocketsByUser.set(userId, next);
  }
}

/**
 * Client-reported activity. The web client owns its own idle timer (10 min
 * of no mouse/keyboard input) and tells the server whenever it crosses the
 * threshold. While DND is on, this still updates the in-memory state but
 * the effective presence remains `dnd`.
 */
export async function reportActivity(userId: string, active: boolean): Promise<void> {
  clientActiveByUser.set(userId, active);
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { manualDnd: true },
  });
  if (!row) return;
  await persistAndBroadcast(userId, compute(userId, row.manualDnd));
}

/**
 * Toggle the sticky DND override.
 */
export async function setManualDnd(userId: string, dnd: boolean): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { manualDnd: dnd },
  });
  await persistAndBroadcast(userId, compute(userId, dnd));
}

/**
 * Set the user's custom status string + optional expiry.
 *
 * Touches `presenceUpdatedAt` so the outbound watermark advances — without
 * that, peers reject the new state as stale and the custom-status update
 * never propagates. After persist we:
 *   1. Broadcast the current effective presence to local gateway subscribers
 *      (the broadcast nudges live clients to re-read the user row, which now
 *      carries the new customStatus + customStatusExpiresAt).
 *   2. Schedule an IMMEDIATE federation fan-out — custom-status changes are
 *      infrequent and user-visible enough that the 5s debounce isn't worth
 *      the latency.
 *
 * No-op if the user row is missing (defensive — matches the
 * persistAndBroadcast posture).
 */
export async function setCustomStatus(
  userId: string,
  status: string,
  expiresAt: Date | null,
): Promise<void> {
  // Single read pulls both the existence-check (`id`) and the `manualDnd`
  // bit needed for the broadcast — `manualDnd` is a sticky user setting
  // that this call doesn't mutate, so reading it before the update is
  // safe and saves a round-trip. The PRESENCE_UPDATE snapshot below uses
  // the NEW `status` / `expiresAt` we're about to write rather than
  // re-reading the row, so a second findUnique isn't needed.
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, manualDnd: true },
  });
  if (!existing) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      customStatus: status,
      customStatusExpiresAt: expiresAt,
      presenceUpdatedAt: new Date(),
    },
  });
  broadcast(userId, {
    presence: compute(userId, existing.manualDnd),
    customStatus: status,
    customStatusExpiresAt: expiresAt,
  });
  scheduleFanOut(userId, /* immediate */ true);
}

/**
 * Clear the user's custom status (both fields → null). Same broadcast +
 * fan-out shape as `setCustomStatus`.
 */
export async function clearCustomStatus(userId: string): Promise<void> {
  // Same shape as setCustomStatus — pull `manualDnd` in the existence
  // check so the post-update broadcast doesn't need a second read. The
  // broadcast snapshot carries the explicit nulls we're about to write.
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, manualDnd: true },
  });
  if (!existing) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      customStatus: null,
      customStatusExpiresAt: null,
      presenceUpdatedAt: new Date(),
    },
  });
  broadcast(userId, {
    presence: compute(userId, existing.manualDnd),
    customStatus: null,
    customStatusExpiresAt: null,
  });
  scheduleFanOut(userId, /* immediate */ true);
}

/**
 * Read the full presence state for a user (used by /me responses).
 */
export async function getPresenceForUser(
  userId: string,
): Promise<{
  presence: Presence;
  manualDnd: boolean;
  customStatus: string | null;
  customStatusExpiresAt: Date | null;
}> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      presence: true,
      manualDnd: true,
      customStatus: true,
      customStatusExpiresAt: true,
    },
  });
  return {
    presence: (row?.presence as Presence | undefined) ?? 'offline',
    manualDnd: row?.manualDnd ?? false,
    customStatus: row?.customStatus ?? null,
    customStatusExpiresAt: row?.customStatusExpiresAt ?? null,
  };
}

// --- Test-only helpers ----------------------------------------------------

/**
 * Drain all pending debounced fan-outs. Used by tests to deterministically
 * trigger debounced timers without waiting wall-clock seconds. Never call
 * from production code.
 */
export function __testFlushDebouncedFanOuts(): void {
  for (const [userId, handle] of debouncedFanOut.entries()) {
    clearTimeout(handle);
    debouncedFanOut.delete(userId);
    void emitFanOut(userId);
  }
}

/**
 * Reset the in-memory presence state. Tests use this between cases to
 * isolate runs.
 */
export function __testResetPresenceState(): void {
  for (const handle of debouncedFanOut.values()) clearTimeout(handle);
  debouncedFanOut.clear();
  clientActiveByUser.clear();
  openSocketsByUser.clear();
}
