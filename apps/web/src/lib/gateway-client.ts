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
  /**
   * The sessionId carried in the previous connection's HELLO. When the
   * socket drops and we reconnect, we send this back via RESUME so the
   * server can splice the buffered events from the orphaned session onto
   * the new socket. Cleared on explicit close() and on INVALID_SESSION.
   */
  private resumeSessionId: string | null = null;
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
    this.resumeSessionId = null;
    this.lastSeq = 0;
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
    // RT-015: add ±20% jitter so a server restart that drops every client
    // doesn't cause them all to reconnect on identical schedules. Without
    // this, exponential backoff with the same base produces synchronized
    // thundering-herd surges every 1s/2s/4s/8s/…
    const base = Math.min(this.backoffMs, 30_000);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.floor(base + jitter));
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
        this.startHeartbeat(d.heartbeatIntervalMs);
        // If we held onto a prior sessionId, ask the server to resume it.
        // Otherwise this is a fresh connection — IDENTIFY normally.
        if (this.resumeSessionId && this.lastSeq > 0) {
          this.resume(this.resumeSessionId, this.lastSeq);
        } else {
          this.identify();
        }
        // Remember this connection's sessionId so the *next* reconnect can
        // ask to resume from here.
        this.resumeSessionId = d.sessionId;
        return;
      }
      case GatewayOp.HEARTBEAT_ACK:
        return;
      case GatewayOp.INVALID_SESSION:
        // Server says the resume target is gone (e.g. BUFFER_GAP). Drop our
        // resume hint and re-IDENTIFY from scratch.
        this.resumeSessionId = null;
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

  private resume(sessionId: string, lastSeq: number): void {
    if (!this.socket) return;
    const token = tokenStore.accessToken;
    if (!token) {
      this.close();
      return;
    }
    this.send({ op: GatewayOp.RESUME, d: { token, sessionId, lastSeq } });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const beat = () => {
      this.send({ op: GatewayOp.HEARTBEAT, d: { seq: this.lastSeq } });
    };
    // Bound the server-supplied interval. The HELLO payload is technically
    // attacker-controlled if the gateway is compromised; an out-of-range
    // value either spins the tab (too small) or silently breaks liveness
    // detection (too large). Validate first, fall back to the constant on
    // bad input so the value reaching the second setInterval is provably
    // within [100ms, 30s].
    if (
      typeof intervalMs !== 'number' ||
      !Number.isFinite(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 30_000
    ) {
      this.heartbeat = setInterval(beat, GATEWAY.HEARTBEAT_INTERVAL_MS);
      return;
    }
    this.heartbeat = setInterval(beat, intervalMs);
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
