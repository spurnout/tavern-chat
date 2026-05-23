/**
 * Backend-agnostic store for short-lived, single-replica-sensitive state:
 * WebAuthn challenges, OIDC `state` parameters, and any future "we issued
 * this token, we want it back" ceremony. The values are deliberately
 * lossy — a Redis hiccup or a process restart means the user retries the
 * dance, not "locked out forever."
 *
 * Two backends:
 *   - `InMemoryEphemeralStore`: a Map with explicit TTL bookkeeping. Used
 *     when REDIS_URL is unset. Fine for single-replica deployments; breaks
 *     the moment the operator scales horizontally.
 *   - `RedisEphemeralStore`: keys live under a namespace prefix with a
 *     server-side EX TTL. Survives restarts (within the window) and works
 *     across replicas, so the same WebAuthn ceremony can land on a
 *     different node and still finish.
 *
 * Callers serialise their own value to JSON; the store doesn't try to be
 * schema-aware. Values are bounded to a few KB in practice — challenges
 * are ~64 bytes plus metadata, OIDC `state` rows are ~100 bytes.
 */

import type { Redis } from 'ioredis';

export interface EphemeralStore {
  /** Returns null when the key is absent OR has expired. */
  get<T>(key: string): Promise<T | null>;
  /** ttlMs is required — there's no "persist forever" mode by design. */
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Hard ceiling for the in-memory backend so a runaway producer can't
 * exhaust the process. When the cap is hit the oldest entry is evicted
 * to make room — same shape as the OIDC `states` cap that was already
 * in place before this abstraction was introduced.
 */
const IN_MEMORY_DEFAULT_CAP = 4_096;

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

export class InMemoryEphemeralStore implements EphemeralStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly cap: number;

  constructor(opts: { cap?: number } = {}) {
    this.cap = opts.cap ?? IN_MEMORY_DEFAULT_CAP;
  }

  async get<T>(key: string): Promise<T | null> {
    const row = this.entries.get(key);
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return row.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.gcExpired();
    if (this.entries.size >= this.cap && !this.entries.has(key)) {
      // Evict oldest insertion-order entry. Map iteration order is insertion
      // order in JS, so .keys().next() gives us the right candidate.
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

/**
 * Redis-backed implementation. Keys are namespaced so a single Redis can
 * host more than one of these stores; values are JSON-encoded.
 *
 * Failure handling: a Redis error on `set` is propagated so the caller can
 * react (most ceremonies will reject the request). A Redis error on `get`
 * is treated as "not found" — fail closed in the same way the in-memory
 * GC would for an expired entry. `delete` swallows errors because the
 * key TTL will sweep eventually.
 */
export class RedisEphemeralStore implements EphemeralStore {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
  ) {}

  private k(key: string): string {
    return `tavern:eph:${this.namespace}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(this.k(key));
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const ms = Math.max(1, Math.floor(ttlMs));
    await this.redis.set(this.k(key), JSON.stringify(value), 'PX', ms);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(this.k(key));
    } catch {
      // Best-effort: the key carries its own TTL so a missed DEL is harmless.
    }
  }
}
