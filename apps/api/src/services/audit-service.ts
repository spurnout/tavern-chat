import { Prisma, prisma } from '@tavern/db';
import { ulid } from '@tavern/shared';

export interface AuditWriteInput {
  serverId?: string | null | undefined;
  actorId?: string | null | undefined;
  action: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export async function writeAuditEntry(input: AuditWriteInput): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      id: ulid(),
      serverId: input.serverId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata:
        input.metadata !== undefined ? (input.metadata as Prisma.InputJsonValue) : undefined,
    },
  });
}
