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
 */

import { prisma } from '@tavern/db';
import type { Presence } from '@tavern/shared';
import { gatewayBroker } from './gateway-broker.js';

const clientActiveByUser = new Map<string, boolean>();
const openSocketsByUser = new Map<string, number>();

function broadcast(userId: string, presence: Presence): void {
  gatewayBroker.publish({
    type: 'PRESENCE_UPDATE',
    userId,
    data: { userId, presence },
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
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { presence: true },
  });
  if (!row) return;
  if (row.presence === next) return;
  await prisma.user.update({
    where: { id: userId },
    data: { presence: next, presenceUpdatedAt: new Date() },
  });
  broadcast(userId, next);
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
 * Read the full presence state for a user (used by /me responses).
 */
export async function getPresenceForUser(
  userId: string,
): Promise<{ presence: Presence; manualDnd: boolean }> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { presence: true, manualDnd: true },
  });
  return {
    presence: (row?.presence as Presence | undefined) ?? 'offline',
    manualDnd: row?.manualDnd ?? false,
  };
}
