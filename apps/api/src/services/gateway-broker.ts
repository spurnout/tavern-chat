/**
 * In-process gateway event broker.
 *
 * Routes call broker.publish(event) when they mutate state. Connected gateway
 * sockets subscribe to relevant scopes (server / channel / user) and decide
 * per-recipient whether to forward, applying permission filtering before send.
 *
 * For multi-process deployments this should be backed by Redis pub/sub. Phase 0
 * starts in-process; Phase 6 polish wires Redis in.
 */

import { EventEmitter } from 'node:events';
import type { GatewayDispatchEventName } from '@tavern/shared';

export interface GatewayEvent<T = unknown> {
  /** Discord-like event name, e.g. MESSAGE_CREATE. */
  type: GatewayDispatchEventName;
  /** Server scope, if applicable. Sockets that are members of this server consider this event. */
  serverId?: string | undefined;
  /** Channel scope; receivers must have VIEW_CHANNEL on this channel. */
  channelId?: string | undefined;
  /** Direct recipient, e.g. a private DM. */
  userId?: string | undefined;
  /** The payload sent to clients verbatim. */
  data: T;
}

export class GatewayBroker {
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
}

export const gatewayBroker = new GatewayBroker();
