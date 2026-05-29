import { describe, expect, it } from 'vitest';
import {
  GatewayDispatchEvent,
  GatewayOp,
  attachmentReadyPayloadSchema,
  gatewayHeartbeatPayloadSchema,
  gatewayHelloPayloadSchema,
  gatewayIdentifyPayloadSchema,
  gatewayPayloadSchema,
  gatewayResumePayloadSchema,
} from '../src/schemas/gateway.js';

describe('GatewayOp / GatewayDispatchEvent constants', () => {
  it('exposes the documented numeric opcodes', () => {
    expect(GatewayOp.DISPATCH).toBe(0);
    expect(GatewayOp.HEARTBEAT).toBe(1);
    expect(GatewayOp.IDENTIFY).toBe(2);
    expect(GatewayOp.RESUME).toBe(3);
    expect(GatewayOp.RECONNECT).toBe(6);
    expect(GatewayOp.INVALID_SESSION).toBe(9);
    expect(GatewayOp.HELLO).toBe(10);
    expect(GatewayOp.HEARTBEAT_ACK).toBe(11);
  });

  it('maps dispatch event names to themselves', () => {
    expect(GatewayDispatchEvent.READY).toBe('READY');
    expect(GatewayDispatchEvent.MESSAGE_CREATE).toBe('MESSAGE_CREATE');
    expect(GatewayDispatchEvent.DM_MESSAGE_CREATE).toBe('DM_MESSAGE_CREATE');
    expect(GatewayDispatchEvent.WHITEBOARD_CLEAR).toBe('WHITEBOARD_CLEAR');
  });
});

describe('gatewayHelloPayloadSchema', () => {
  it('accepts a positive integer interval and a sessionId', () => {
    const result = gatewayHelloPayloadSchema.safeParse({
      heartbeatIntervalMs: 30_000,
      sessionId: '01HZX7Q4Y3K9V0G8WMC2P5N6BR',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty-string sessionId (no min constraint)', () => {
    const result = gatewayHelloPayloadSchema.safeParse({
      heartbeatIntervalMs: 1,
      sessionId: '',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive interval', () => {
    expect(
      gatewayHelloPayloadSchema.safeParse({ heartbeatIntervalMs: 0, sessionId: 's' }).success,
    ).toBe(false);
    expect(
      gatewayHelloPayloadSchema.safeParse({ heartbeatIntervalMs: -5, sessionId: 's' }).success,
    ).toBe(false);
  });

  it('rejects a non-integer interval', () => {
    expect(
      gatewayHelloPayloadSchema.safeParse({ heartbeatIntervalMs: 12.5, sessionId: 's' }).success,
    ).toBe(false);
  });

  it('rejects a missing sessionId', () => {
    expect(gatewayHelloPayloadSchema.safeParse({ heartbeatIntervalMs: 30_000 }).success).toBe(
      false,
    );
  });
});

describe('gatewayIdentifyPayloadSchema', () => {
  it('accepts a token with an explicit capabilities array', () => {
    const result = gatewayIdentifyPayloadSchema.safeParse({
      token: 'abc.def.ghi',
      capabilities: ['dms', 'presence'],
    });
    expect(result.success).toBe(true);
  });

  it('defaults capabilities to an empty array when omitted', () => {
    const parsed = gatewayIdentifyPayloadSchema.parse({ token: 'abc' });
    expect(parsed.capabilities).toEqual([]);
  });

  it('rejects an empty token', () => {
    expect(gatewayIdentifyPayloadSchema.safeParse({ token: '' }).success).toBe(false);
  });

  it('rejects a missing token', () => {
    expect(gatewayIdentifyPayloadSchema.safeParse({ capabilities: [] }).success).toBe(false);
  });

  it('rejects non-string capability entries', () => {
    expect(
      gatewayIdentifyPayloadSchema.safeParse({ token: 'abc', capabilities: [1, 2] }).success,
    ).toBe(false);
  });
});

describe('gatewayResumePayloadSchema', () => {
  it('accepts a token, sessionId and a non-negative lastSeq', () => {
    const result = gatewayResumePayloadSchema.safeParse({
      token: 'abc',
      sessionId: 'sess-1',
      lastSeq: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty sessionId', () => {
    expect(
      gatewayResumePayloadSchema.safeParse({ token: 'abc', sessionId: '', lastSeq: 1 }).success,
    ).toBe(false);
  });

  it('rejects a negative lastSeq', () => {
    expect(
      gatewayResumePayloadSchema.safeParse({ token: 'abc', sessionId: 's', lastSeq: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer lastSeq', () => {
    expect(
      gatewayResumePayloadSchema.safeParse({ token: 'abc', sessionId: 's', lastSeq: 2.7 }).success,
    ).toBe(false);
  });
});

describe('gatewayHeartbeatPayloadSchema', () => {
  it('accepts a non-negative integer seq', () => {
    expect(gatewayHeartbeatPayloadSchema.safeParse({ seq: 42 }).success).toBe(true);
  });

  it('accepts a null seq', () => {
    expect(gatewayHeartbeatPayloadSchema.safeParse({ seq: null }).success).toBe(true);
  });

  it('rejects a negative seq', () => {
    expect(gatewayHeartbeatPayloadSchema.safeParse({ seq: -1 }).success).toBe(false);
  });

  it('rejects a missing seq (required even though nullable)', () => {
    expect(gatewayHeartbeatPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('gatewayPayloadSchema', () => {
  it('accepts a minimal dispatch envelope with only op + d', () => {
    const result = gatewayPayloadSchema.safeParse({ op: 0, d: { anything: true } });
    expect(result.success).toBe(true);
  });

  it('accepts a full envelope with s and t present', () => {
    const result = gatewayPayloadSchema.safeParse({
      op: 0,
      d: null,
      s: 7,
      t: 'MESSAGE_CREATE',
    });
    expect(result.success).toBe(true);
  });

  it('accepts null s and null t', () => {
    const result = gatewayPayloadSchema.safeParse({ op: 11, d: undefined, s: null, t: null });
    expect(result.success).toBe(true);
  });

  it('rejects a negative op', () => {
    expect(gatewayPayloadSchema.safeParse({ op: -1, d: null }).success).toBe(false);
  });

  it('rejects a non-integer op', () => {
    expect(gatewayPayloadSchema.safeParse({ op: 1.5, d: null }).success).toBe(false);
  });

  it('rejects a missing op', () => {
    expect(gatewayPayloadSchema.safeParse({ d: null }).success).toBe(false);
  });

  it('rejects a non-string t', () => {
    expect(gatewayPayloadSchema.safeParse({ op: 0, d: null, t: 123 }).success).toBe(false);
  });
});

describe('attachmentReadyPayloadSchema', () => {
  it('accepts an attachmentId with a status', () => {
    const result = attachmentReadyPayloadSchema.safeParse({
      attachmentId: '01HZX7Q4Y3K9V0G8WMC2P5N6BR',
      status: 'ready',
    });
    expect(result.success).toBe(true);
  });

  it('accepts non-ready terminal statuses', () => {
    for (const status of ['failed', 'blocked', 'quarantined']) {
      expect(
        attachmentReadyPayloadSchema.safeParse({ attachmentId: 'a', status }).success,
      ).toBe(true);
    }
  });

  it('rejects an empty attachmentId', () => {
    expect(attachmentReadyPayloadSchema.safeParse({ attachmentId: '', status: 'ready' }).success).toBe(
      false,
    );
  });

  it('rejects an empty status', () => {
    expect(attachmentReadyPayloadSchema.safeParse({ attachmentId: 'a', status: '' }).success).toBe(
      false,
    );
  });

  it('rejects a missing status', () => {
    expect(attachmentReadyPayloadSchema.safeParse({ attachmentId: 'a' }).success).toBe(false);
  });
});
