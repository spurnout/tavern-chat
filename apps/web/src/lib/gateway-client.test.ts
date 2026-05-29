import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayOp } from '@tavern/shared';
import { GatewayClient } from './gateway-client.js';
import { tokenStore } from './api-client.js';

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static OPEN = 1;

  readyState = FakeWebSocket.OPEN;
  sent: Array<{ op: number; d: unknown }> = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as { op: number; d: unknown });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emitClose();
  }

  emitMessage(payload: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  emitClose(): void {
    for (const listener of this.listeners.get('close') ?? []) {
      listener({});
    }
  }
}

let sockets: FakeWebSocket[] = [];

function issueToken(): void {
  tokenStore.set({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    refreshTokenExpiresAt: '2099-01-02T00:00:00.000Z',
  });
}

function hello(socket: FakeWebSocket, sessionId: string): void {
  socket.emitMessage({
    op: GatewayOp.HELLO,
    d: { sessionId, heartbeatIntervalMs: 10_000 },
    s: null,
    t: null,
  });
}

function ready(socket: FakeWebSocket, seq: number): void {
  socket.emitMessage({
    op: GatewayOp.DISPATCH,
    d: {},
    s: seq,
    t: 'READY',
  });
}

describe('GatewayClient resume state', () => {
  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    issueToken();
  });

  afterEach(() => {
    tokenStore.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the current HELLO session resumable after INVALID_SESSION re-identify', () => {
    const client = new GatewayClient({
      url: 'ws://tavern.test/gateway',
      onDispatch: () => undefined,
    });

    client.connect();
    const first = sockets[0]!;
    hello(first, 'session-a');
    expect(first.sent.at(-1)).toMatchObject({ op: GatewayOp.IDENTIFY });
    ready(first, 1);

    first.emitClose();
    vi.advanceTimersByTime(2_000);

    const second = sockets[1]!;
    hello(second, 'session-b');
    expect(second.sent.at(-1)).toMatchObject({
      op: GatewayOp.RESUME,
      d: { sessionId: 'session-a', lastSeq: 1 },
    });

    second.emitMessage({
      op: GatewayOp.INVALID_SESSION,
      d: { reason: 'BUFFER_GAP' },
      s: null,
      t: null,
    });
    expect(second.sent.at(-1)).toMatchObject({ op: GatewayOp.IDENTIFY });
    ready(second, 2);

    second.emitClose();
    vi.advanceTimersByTime(4_000);

    const third = sockets[2]!;
    hello(third, 'session-c');
    expect(third.sent.at(-1)).toMatchObject({
      op: GatewayOp.RESUME,
      d: { sessionId: 'session-b', lastSeq: 2 },
    });

    client.close();
  });
});
