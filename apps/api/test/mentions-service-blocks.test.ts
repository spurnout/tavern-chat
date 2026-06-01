/**
 * Unit tests for the block filter in resolveMentionRecipients.
 *
 * A member who has blocked the author must never be returned as a mention
 * recipient — so no UserMention row, MENTION_CREATE, or mentionCount bump is
 * produced for them. We mock the transaction client and assert the blocked
 * recipient is dropped while others survive.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { resolveMentionRecipients } from '../src/services/mentions-service.js';

interface MockRows {
  everyoneMembers: Array<{ userId: string }>;
  blocks: Array<{ blockerId: string }>;
}

function makeTx(rows: MockRows): Prisma.TransactionClient {
  return {
    serverMember: {
      findMany: vi.fn().mockResolvedValue(rows.everyoneMembers),
    },
    role: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    userBlock: {
      findMany: vi.fn().mockResolvedValue(rows.blocks),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('resolveMentionRecipients block filter', () => {
  const parsedEveryone = [
    { kind: 'group' as const, group: 'everyone' as const, raw: '@everyone' },
  ];

  it('drops a recipient who has blocked the author', async () => {
    const tx = makeTx({
      everyoneMembers: [{ userId: 'u1' }, { userId: 'u2' }],
      blocks: [{ blockerId: 'u2' }], // u2 blocked the author
    });

    const recipients = await resolveMentionRecipients({
      tx,
      parsed: parsedEveryone,
      serverId: 's1',
      authorId: 'author',
    });

    const ids = recipients.map((r) => r.userId).sort();
    expect(ids).toEqual(['u1']);
    expect(tx.userBlock.findMany).toHaveBeenCalledWith({
      where: { blockedId: 'author', blockerId: { in: ['u1', 'u2'] } },
      select: { blockerId: true },
    });
  });

  it('keeps every recipient when there are no blocks', async () => {
    const tx = makeTx({
      everyoneMembers: [{ userId: 'u1' }, { userId: 'u2' }],
      blocks: [],
    });

    const recipients = await resolveMentionRecipients({
      tx,
      parsed: parsedEveryone,
      serverId: 's1',
      authorId: 'author',
    });

    expect(recipients.map((r) => r.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('does not query blocks when there are no candidate recipients', async () => {
    const tx = makeTx({ everyoneMembers: [], blocks: [] });

    const recipients = await resolveMentionRecipients({
      tx,
      parsed: parsedEveryone,
      serverId: 's1',
      authorId: 'author',
    });

    expect(recipients).toEqual([]);
    expect(tx.userBlock.findMany).not.toHaveBeenCalled();
  });
});
