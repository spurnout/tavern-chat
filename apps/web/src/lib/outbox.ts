import { api, ApiError } from './api-client.js';

/**
 * Wave 3 #27 — Offline message queue.
 *
 * Compose-while-offline: when a send fails because the network is gone, the
 * SPA stashes the payload in localStorage (small, synchronous, fine for the
 * tiny outbox volumes we expect). On reconnect, the queue drains in FIFO
 * order with the same nonce as the original send so dedupe is automatic.
 */

const KEY = 'tavern.outbox.v1';

interface OutboxEntry {
  id: string;
  /** Server endpoint path (without /api). */
  path: string;
  body: unknown;
  queuedAt: number;
}

function read(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OutboxEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: OutboxEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded — drop the oldest half and try again.
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(-25)));
    } catch {
      // Storage broken — give up silently.
    }
  }
}

export function queueOutbox(entry: Omit<OutboxEntry, 'id' | 'queuedAt'>): string {
  const id = crypto.randomUUID();
  const entries = read();
  entries.push({ ...entry, id, queuedAt: Date.now() });
  write(entries);
  return id;
}

export function getOutbox(): OutboxEntry[] {
  return read();
}

export async function drainOutbox(): Promise<void> {
  let entries = read();
  while (entries.length > 0) {
    const next = entries[0]!;
    try {
      await api(next.path, { method: 'POST', body: next.body });
      // Drop the head.
      entries = entries.slice(1);
      write(entries);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // Permanent — won't succeed on retry, drop it to avoid blocking the queue.
        entries = entries.slice(1);
        write(entries);
        continue;
      }
      // Transient — stop draining and retry on the next online window.
      return;
    }
  }
}

/** Call once on app boot. Drains when the browser reports online. */
export function installOutboxAutoDrain(): () => void {
  const handler = (): void => {
    if (!navigator.onLine) return;
    void drainOutbox();
  };
  window.addEventListener('online', handler);
  // Also try immediately in case we're already online with pending items.
  handler();
  return () => window.removeEventListener('online', handler);
}
