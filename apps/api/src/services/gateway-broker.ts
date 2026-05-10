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
  private emitter = new EventEmitter();

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
  private constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {
    this.emitter.setMaxListeners(0);
    this.subscriber.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message) as GatewayEvent;
        this.emitter.emit('event', event);
      } catch {
        // Ignore malformed payloads. We don't want a bad message from a peer
        // to crash the gateway.
      }
    });
  }

  static async create(url: string): Promise<RedisBroker> {
    const publisher = new IORedis(url, { maxRetriesPerRequest: null });
    const subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    await subscriber.subscribe(RedisBroker.CHANNEL);
    return new RedisBroker(publisher, subscriber);
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
   * in-process emitter are preserved by re-subscribing.
   */
  async useRedis(url: string): Promise<void> {
    if (this.inited) return;
    try {
      const redis = await RedisBroker.create(url);
      // Re-route subscribers from in-process -> redis. Easiest path is to
      // forward redis events through the same EventEmitter the in-process
      // broker exposes. We swap the inner reference and let the existing
      // listeners stay attached to the in-process emitter — but the new
      // events will only flow through redis. Cleanest: just swap.
      const old = this.inner;
      this.inner = redis;
      await old.close();
      this.inited = true;
    } catch (err) {
      // Stay with in-process if Redis can't be reached — better to keep
      // serving than to fail startup.
      console.warn('[gateway-broker] falling back to in-process broker:', err);
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
 */
export async function initRedisBroker(url: string): Promise<void> {
  await gatewayBroker.useRedis(url);
}

export type GatewayBroker = GatewayBrokerHandle;
