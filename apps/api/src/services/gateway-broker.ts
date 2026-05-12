/**
 * Gateway event broker.
 *
 * Implements a small publish/subscribe interface used by routes (which mutate
 * state) and the gateway (which fans out events to connected sockets after
 * applying per-recipient permission checks).
 *
 * Two implementations:
 *
 *   InProcessBroker — a Node EventEmitter; only sees events from this process.
 *                     Fine for single-replica deployments and tests.
 *
 *   RedisBroker     — fans out via Redis pub/sub on a single channel. Required
 *                     for multi-replica deployments where any process can take
 *                     over a websocket and may need to deliver an event a peer
 *                     produced.
 *
 * The exported singleton `gatewayBroker` is a thin handle that can be backed
 * by either; we initialize it lazily based on whether REDIS_URL is reachable.
 */

import { EventEmitter } from 'node:events';
import IORedis, { type Redis } from 'ioredis';
import type { GatewayDispatchEventName } from '@tavern/shared';

export interface GatewayEvent<T = unknown> {
  type: GatewayDispatchEventName;
  serverId?: string | undefined;
  channelId?: string | undefined;
  userId?: string | undefined;
  data: T;
}

export interface GatewayBrokerHandle {
  publish<T>(event: GatewayEvent<T>): void;
  subscribe(handler: (event: GatewayEvent) => void): () => void;
  close(): Promise<void>;
}

class InProcessBroker implements GatewayBrokerHandle {
  readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish<T>(event: GatewayEvent<T>): void {
    this.emitter.emit('event', event);
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

class RedisBroker implements GatewayBrokerHandle {
  private static CHANNEL = 'tavern:gateway';
  private emitter = new EventEmitter();
  private readonly log: (msg: unknown) => void;
  private constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    log: (msg: unknown) => void,
  ) {
    this.emitter.setMaxListeners(0);
    this.log = log;
    this.subscriber.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message) as GatewayEvent;
        this.emitter.emit('event', event);
      } catch (err) {
        // RT-004: a malformed payload is a peer bug or a protocol break, not a
        // benign event. Log so it shows up in dashboards and can be alerted on;
        // truncate the message body so a runaway peer can't flood logs.
        this.log({
          msg: 'gateway.broker.malformed_payload',
          err: err instanceof Error ? err.message : String(err),
          preview: typeof message === 'string' ? message.slice(0, 200) : null,
        });
      }
    });
  }

  static async create(
    url: string,
    log: (msg: unknown) => void = (m) => console.warn('[gateway-broker]', m),
  ): Promise<RedisBroker> {
    const publisher = new IORedis(url, { maxRetriesPerRequest: null });
    const subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    await subscriber.subscribe(RedisBroker.CHANNEL);
    return new RedisBroker(publisher, subscriber, log);
  }

  /**
   * RT-006 plumbing: the in-process broker exposes its EventEmitter so the
   * LazyBroker can re-attach existing subscribers to the Redis-backed
   * emitter when it promotes.
   */
  attachListenersFrom(other: EventEmitter): void {
    for (const listener of other.listeners('event')) {
      this.emitter.on('event', listener as (event: GatewayEvent) => void);
    }
  }

  publish<T>(event: GatewayEvent<T>): void {
    void this.publisher.publish(RedisBroker.CHANNEL, JSON.stringify(event));
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  async close(): Promise<void> {
    await this.subscriber.unsubscribe(RedisBroker.CHANNEL).catch(() => undefined);
    this.subscriber.disconnect();
    this.publisher.disconnect();
  }
}

class LazyBroker implements GatewayBrokerHandle {
  private inner: GatewayBrokerHandle = new InProcessBroker();
  private inited = false;

  /**
   * Promote to a Redis-backed broker. Existing subscriptions on the
   * in-process emitter are migrated to the new Redis broker — the previous
   * implementation simply swapped `inner` and `close()`-d the old emitter,
   * orphaning every listener registered before promotion and silently
   * disabling all cross-replica fanout. RT-006.
   */
  async useRedis(
    url: string,
    log: (msg: unknown) => void = (m) => console.warn('[gateway-broker]', m),
  ): Promise<void> {
    if (this.inited) return;
    try {
      const redis = await RedisBroker.create(url, log);
      const old = this.inner;
      if (old instanceof InProcessBroker) {
        // Re-attach every existing handler to the Redis broker's internal
        // emitter so that future events delivered via Redis pub/sub still
        // reach handlers that subscribed before promotion.
        redis.attachListenersFrom(old.emitter);
      }
      this.inner = redis;
      await old.close();
      this.inited = true;
    } catch (err) {
      // Stay with in-process if Redis can't be reached — better to keep
      // serving than to fail startup.
      log({ msg: 'gateway-broker fallback to in-process', err: err instanceof Error ? err.message : String(err) });
    }
  }

  publish<T>(event: GatewayEvent<T>): void {
    this.inner.publish(event);
  }

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    return this.inner.subscribe(handler);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export const gatewayBroker = new LazyBroker();

/**
 * Promote the broker to Redis-backed pub/sub. Call once during startup with
 * the API's REDIS_URL. Safe to call multiple times — second call is a no-op.
 * The optional logger is forwarded to the broker for structured malformed-
 * payload reporting (RT-004) and fallback diagnostics (RT-006).
 */
export async function initRedisBroker(
  url: string,
  log?: (msg: unknown) => void,
): Promise<void> {
  await gatewayBroker.useRedis(url, log);
}

export type GatewayBroker = GatewayBrokerHandle;
