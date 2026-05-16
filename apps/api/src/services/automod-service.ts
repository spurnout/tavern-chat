import type { Prisma } from '@prisma/client';
import { prisma } from '@tavern/db';

/**
 * Wave 3 #15 — automod evaluation. Called from the message-create path
 * before the row is persisted. Returns the first matched rule (if any);
 * the caller maps the rule's `action` to a concrete outcome.
 *
 * Keep this fast — it runs on every server-channel message. Patterns and
 * rule lists are small in practice (~10 per server); a single trip to the
 * DB + an O(n*m) regex sweep is acceptable.
 *
 * For `link_rate` / `message_rate` we track per-(server, user) timestamps
 * in-memory. These are best-effort across replicas; a Redis-backed counter
 * is a follow-up.
 */

interface RateState {
  /** Recent timestamps (ms epoch). Capped at 64 entries per key. */
  events: number[];
}
const rateState = new Map<string, RateState>();

const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]]+/g;

export interface AutomodHit {
  rule: Prisma.AutomodRuleGetPayload<true>;
}

export async function evaluateAutomod(opts: {
  serverId: string;
  userId: string;
  content: string;
}): Promise<AutomodHit | null> {
  const rules = await prisma.automodRule.findMany({
    where: { serverId: opts.serverId, enabled: true },
    orderBy: { position: 'asc' },
  });
  for (const rule of rules) {
    if (matches(rule, opts.userId, opts.content, opts.serverId)) {
      return { rule };
    }
  }
  return null;
}

function matches(
  rule: Prisma.AutomodRuleGetPayload<true>,
  userId: string,
  content: string,
  serverId: string,
): boolean {
  switch (rule.kind) {
    case 'regex': {
      try {
        return new RegExp(rule.pattern, 'i').test(content);
      } catch {
        return false;
      }
    }
    case 'wordlist': {
      const words = rule.pattern
        .split(/[\s,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const lower = content.toLowerCase();
      return words.some((w) => lower.includes(w));
    }
    case 'link_rate': {
      const limit = Number(rule.pattern) || 5;
      const window = 60_000;
      const key = `link:${serverId}:${userId}`;
      const urls = content.match(URL_RE) ?? [];
      if (urls.length === 0) return false;
      const state = rateState.get(key) ?? { events: [] };
      const now = Date.now();
      state.events = state.events.filter((t) => now - t < window).slice(-64);
      state.events.push(...urls.map(() => now));
      rateState.set(key, state);
      return state.events.length > limit;
    }
    case 'message_rate': {
      const limit = Number(rule.pattern) || 10;
      const window = 60_000;
      const key = `msg:${serverId}:${userId}`;
      const state = rateState.get(key) ?? { events: [] };
      const now = Date.now();
      state.events = state.events.filter((t) => now - t < window).slice(-64);
      state.events.push(now);
      rateState.set(key, state);
      return state.events.length > limit;
    }
    default:
      return false;
  }
}
