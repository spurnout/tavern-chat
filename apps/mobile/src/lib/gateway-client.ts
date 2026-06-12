import { GATEWAY } from '@tavern/shared/constants';
import {
  GatewayOp,
  type GatewayDispatchEventName,
  type GatewayPayload,
} from '@tavern/shared/schemas';

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

interface GatewayClientOptions {
  url: string;
  getAccessToken: () => string | null;
  onDispatch: (event: GatewayDispatchEventName, data: unknown) => void;
  onStatusChange?: (status: GatewayStatus) => void;
}

export class GatewayClient {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private lastSeq = 0;
  private currentSessionId: string | null = null;
  private resumeSessionId: string | null = null;
  private status: GatewayStatus = 'idle';

  constructor(private readonly opts: GatewayClientOptions) {}

  connect(): void {
    if (this.socket || this.status === 'connecting' || this.status === 'reconnecting') return;
    if (!this.opts.getAccessToken()) {
      this.close();
      return;
    }
    this.setStatus('connecting');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = new WebSocket(this.opts.url);
    this.socket = socket;

    socket.onmessage = (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : '') as GatewayPayload;
      } catch {
        return;
      }
      this.handlePayload(payload);
    };
    socket.onclose = () => {
      this.cleanupSocket();
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // The close event owns reconnect behaviour.
    };
  }

  close(): void {
    this.setStatus('closed');
    this.currentSessionId = null;
    this.resumeSessionId = null;
    this.lastSeq = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }

  private cleanupSocket(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Ignore stale sockets.
      }
    }
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.status === 'closed') return;
    if (!this.opts.getAccessToken()) {
      this.close();
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.setStatus('reconnecting');
    const base = Math.min(this.backoffMs, 30_000);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.max(250, Math.floor(base + jitter));
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === 'reconnecting') this.setStatus('idle');
      this.connect();
    }, delay);
  }

  private setStatus(status: GatewayStatus): void {
    this.status = status;
    this.opts.onStatusChange?.(status);
  }

  private handlePayload(payload: GatewayPayload): void {
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case GatewayOp.HELLO: {
        const hello = payload.d as { sessionId: string; heartbeatIntervalMs: number };
        this.startHeartbeat(hello.heartbeatIntervalMs);
        this.currentSessionId = hello.sessionId;
        if (this.resumeSessionId && this.lastSeq > 0) {
          this.resume(this.resumeSessionId, this.lastSeq);
          this.backoffMs = 1_000;
          this.setStatus('ready');
        } else {
          this.identify();
        }
        this.resumeSessionId = hello.sessionId;
        return;
      }
      case GatewayOp.HEARTBEAT_ACK:
        return;
      case GatewayOp.INVALID_SESSION:
        this.resumeSessionId = this.currentSessionId;
        this.lastSeq = 0;
        this.identify();
        return;
      case GatewayOp.DISPATCH: {
        const eventName = payload.t;
        if (!eventName) return;
        if (eventName === 'READY') {
          this.backoffMs = 1_000;
          this.setStatus('ready');
        }
        this.opts.onDispatch(eventName, payload.d);
        return;
      }
      default:
        return;
    }
  }

  private identify(): void {
    const token = this.opts.getAccessToken();
    if (!token) {
      this.close();
      return;
    }
    this.send({ op: GatewayOp.IDENTIFY, d: { token, capabilities: ['mobile'] } });
  }

  private resume(sessionId: string, lastSeq: number): void {
    const token = this.opts.getAccessToken();
    if (!token) {
      this.close();
      return;
    }
    this.send({ op: GatewayOp.RESUME, d: { token, sessionId, lastSeq } });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const beat = () => this.send({ op: GatewayOp.HEARTBEAT, d: { seq: this.lastSeq } });
    if (
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
      // The reconnect path catches broken sockets.
    }
  }
}
