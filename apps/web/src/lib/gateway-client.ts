import {
  GATEWAY,
  GatewayOp,
  type GatewayDispatchEventName,
  type GatewayPayload,
} from '@tavern/shared';
import { tokenStore } from './api-client.js';

export type DispatchHandler = (event: GatewayDispatchEventName, data: unknown) => void;

interface GatewayClientOptions {
  url?: string;
  onDispatch: DispatchHandler;
  onStatusChange?: (status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed') => void;
}

export class GatewayClient {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private lastSeq = 0;
  private status: 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed' = 'idle';

  constructor(private readonly opts: GatewayClientOptions) {}

  connect(): void {
    if (this.socket || this.status === 'connecting') return;
    const url = this.opts.url ?? this.defaultUrl();
    this.setStatus('connecting');

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('message', (e) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      this.handlePayload(payload);
    });

    socket.addEventListener('close', () => {
      this.cleanupSocket();
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // Let `close` handle the reconnect path.
    });
  }

  close(): void {
    this.setStatus('closed');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.cleanupSocket();
  }

  private cleanupSocket(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.status === 'closed') return;
    this.setStatus('reconnecting');
    const delay = Math.min(this.backoffMs, 30_000);
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private setStatus(s: typeof this.status): void {
    this.status = s;
    this.opts.onStatusChange?.(s);
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const d = payload.d as { sessionId: string; heartbeatIntervalMs: number };
        this.identify();
        this.startHeartbeat(d.heartbeatIntervalMs);
        return;
      }
      case GatewayOp.HEARTBEAT_ACK:
        return;
      case GatewayOp.INVALID_SESSION:
        // Force a fresh IDENTIFY.
        this.lastSeq = 0;
        this.identify();
        return;
      case GatewayOp.DISPATCH: {
        const t = payload.t as GatewayDispatchEventName | undefined;
        if (!t) return;
        if (t === 'READY') {
          this.backoffMs = 1_000;
          this.setStatus('ready');
        }
        this.opts.onDispatch(t, payload.d);
        return;
      }
      default:
        return;
    }
  }

  private identify(): void {
    if (!this.socket) return;
    const token = tokenStore.accessToken;
    if (!token) {
      this.close();
      return;
    }
    this.send({ op: GatewayOp.IDENTIFY, d: { token, capabilities: [] } });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const beat = () => {
      this.send({ op: GatewayOp.HEARTBEAT, d: { seq: this.lastSeq } });
    };
    this.heartbeat = setInterval(beat, intervalMs ?? GATEWAY.HEARTBEAT_INTERVAL_MS);
  }

  private send(payload: { op: number; d: unknown }): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  private defaultUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/gateway`;
  }
}
