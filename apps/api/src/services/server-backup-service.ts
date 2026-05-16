import archiver from 'archiver';
import { prisma } from '@tavern/db';
import type { FastifyBaseLogger } from 'fastify';
import type { StorageBackend } from '@tavern/media';
import { gatewayBroker } from './gateway-broker.js';

/**
 * Wave 3 — replaces the original "just count rows into a JSON field"
 * server-backup MVP with a real zip + storage upload.
 *
 * What's in the archive:
 *   - server.json: top-level server, default role, owner reference
 *   - channels.json: category, text, and voice channels (no message bodies)
 *   - roles.json + permission-overwrites.json
 *   - members.json: serverMember + role assignments (password hashes excluded)
 *   - messages.json: all messages (including DM channels in this server's scope are not included)
 *   - attachments.json: attachment metadata only
 *   - reactions.json, pinned-messages.json, threads.json, polls.json
 *   - dice-rolls.json, campaign-notes.json, handouts.json, sessions.json
 *   - safety-policy.json, automod-rules.json, join-gates.json, audit-log.json
 *
 * Restore is intentionally out of scope here — a follow-up project. The
 * file format aims for "round-trippable JSONL" so a future restore command
 * can replay each table in dependency order.
 */
export async function runServerBackupJob(
  backupId: string,
  storage: StorageBackend,
  log: FastifyBaseLogger,
): Promise<void> {
  await prisma.serverBackup.update({
    where: { id: backupId },
    data: { status: 'running', startedAt: new Date() },
  });
  try {
    const job = await prisma.serverBackup.findUniqueOrThrow({ where: { id: backupId } });
    const zipBuffer = await buildServerBackupZip(job.serverId);
    const storageKey = `server-backups/${job.serverId}/${job.id}.zip`;
    await storage.putObject(storage.mainBucket, storageKey, zipBuffer, 'application/zip');
    await prisma.serverBackup.update({
      where: { id: backupId },
      data: {
        status: 'ready',
        finishedAt: new Date(),
        storageBucket: storage.mainBucket,
        storageKey,
        sizeBytes: zipBuffer.length,
      },
    });
    gatewayBroker.publish({
      type: 'EXPORT_READY',
      serverId: job.serverId,
      data: { kind: 'server-backup', id: backupId, status: 'ready', sizeBytes: zipBuffer.length },
    });
    log.info(
      { event: 'server-backup.ready', backupId, serverId: job.serverId, sizeBytes: zipBuffer.length },
      'server backup ready',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.serverBackup
      .update({
        where: { id: backupId },
        data: { status: 'failed', finishedAt: new Date(), failureReason: message },
      })
      .catch(() => undefined);
    const job = await prisma.serverBackup.findUnique({ where: { id: backupId } });
    if (job) {
      gatewayBroker.publish({
        type: 'EXPORT_READY',
        serverId: job.serverId,
        data: { kind: 'server-backup', id: backupId, status: 'failed' },
      });
    }
    log.warn({ event: 'server-backup.failed', backupId, err: message }, 'server backup failed');
  }
}

async function buildServerBackupZip(serverId: string): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (c: Buffer) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', reject);
    archive.on('error', reject);
  });

  archive.append(
    [
      'Tavern server backup',
      '',
      `Server: ${serverId}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Each *.json file is newline-delimited JSON (one row per line). The',
      'archive currently captures schema rows — message attachments and',
      'voice recordings are not inlined; their storage keys are present in',
      'attachments.json so a follow-up restore tool can re-fetch them.',
    ].join('\n'),
    { name: 'README.txt' },
  );

  const server = await prisma.server.findUniqueOrThrow({
    where: { id: serverId },
    select: {
      id: true,
      ownerUserId: true,
      name: true,
      description: true,
      defaultRoleId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  archive.append(jsonl([server]), { name: 'server.json' });

  const [channels, roles, overwrites, members] = await Promise.all([
    prisma.channel.findMany({
      where: { serverId },
      orderBy: { position: 'asc' },
    }),
    prisma.role.findMany({ where: { serverId }, orderBy: { position: 'asc' } }),
    prisma.permissionOverwrite.findMany({
      where: { channel: { serverId } },
    }),
    prisma.serverMember.findMany({
      where: { serverId },
      include: { roles: { select: { roleId: true } } },
    }),
  ]);
  archive.append(jsonl(channels), { name: 'channels.json' });
  archive.append(jsonl(roles), { name: 'roles.json' });
  archive.append(jsonl(overwrites), { name: 'permission-overwrites.json' });
  archive.append(jsonl(members), { name: 'members.json' });

  // Messages — biggest table, by far. We page through to avoid pinning a
  // million rows in memory; the consumer also doesn't need them all at once.
  const messageBatchSize = 1000;
  let cursor: string | undefined;
  let batchIdx = 0;
  // We emit each batch as a separate stream entry. archiver supports
  // multiple appends to distinct names, so messages.001.json, 002.json, etc.
  while (true) {
    const batch = await prisma.message.findMany({
      where: { serverId },
      orderBy: { id: 'asc' },
      take: messageBatchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        channelId: true,
        authorId: true,
        type: true,
        content: true,
        replyToMessageId: true,
        threadId: true,
        diceRollId: true,
        createdAt: true,
        editedAt: true,
        deletedAt: true,
      },
    });
    if (batch.length === 0) break;
    archive.append(jsonl(batch), {
      name: `messages.${String(batchIdx).padStart(3, '0')}.json`,
    });
    batchIdx += 1;
    if (batch.length < messageBatchSize) break;
    cursor = batch[batch.length - 1]?.id;
    if (!cursor) break;
  }

  // Side tables — small enough to fit one shot each.
  const [
    attachments,
    reactions,
    pinned,
    threads,
    polls,
    pollOptions,
    pollVotes,
    diceRolls,
    customEmoji,
    safetyPolicy,
    automodRules,
    joinGate,
    auditLog,
  ] = await Promise.all([
    prisma.attachment.findMany({ where: { message: { serverId } } }),
    prisma.messageReaction.findMany({ where: { message: { serverId } } }),
    prisma.pinnedMessage.findMany({ where: { channel: { serverId } } }),
    prisma.thread.findMany({ where: { channel: { serverId } } }),
    prisma.poll.findMany({ where: { message: { serverId } } }),
    prisma.pollOption.findMany({ where: { poll: { message: { serverId } } } }),
    prisma.pollVote.findMany({ where: { poll: { message: { serverId } } } }),
    prisma.diceRoll.findMany({ where: { serverId } }),
    prisma.customEmoji.findMany({ where: { serverId } }),
    prisma.safetyPolicy.findUnique({ where: { serverId } }),
    prisma.automodRule.findMany({ where: { serverId } }),
    prisma.joinGate.findUnique({ where: { serverId } }),
    prisma.auditLogEntry.findMany({ where: { serverId } }),
  ]);
  archive.append(jsonl(attachments), { name: 'attachments.json' });
  archive.append(jsonl(reactions), { name: 'reactions.json' });
  archive.append(jsonl(pinned), { name: 'pinned-messages.json' });
  archive.append(jsonl(threads), { name: 'threads.json' });
  archive.append(jsonl(polls), { name: 'polls.json' });
  archive.append(jsonl(pollOptions), { name: 'poll-options.json' });
  archive.append(jsonl(pollVotes), { name: 'poll-votes.json' });
  archive.append(jsonl(diceRolls), { name: 'dice-rolls.json' });
  archive.append(jsonl(customEmoji), { name: 'custom-emoji.json' });
  archive.append(jsonl(safetyPolicy ? [safetyPolicy] : []), { name: 'safety-policy.json' });
  archive.append(jsonl(automodRules), { name: 'automod-rules.json' });
  archive.append(jsonl(joinGate ? [joinGate] : []), { name: 'join-gate.json' });
  archive.append(jsonl(auditLog), { name: 'audit-log.json' });

  // Campaign artefacts — scoped to this server.
  const [campaigns, sessions, notes, handouts] = await Promise.all([
    prisma.campaign.findMany({ where: { serverId } }),
    prisma.campaignSession.findMany({ where: { campaign: { serverId } } }),
    prisma.campaignNote.findMany({ where: { serverId } }),
    prisma.handout.findMany({ where: { campaign: { serverId } } }),
  ]);
  archive.append(jsonl(campaigns), { name: 'campaigns.json' });
  archive.append(jsonl(sessions), { name: 'campaign-sessions.json' });
  archive.append(jsonl(notes), { name: 'campaign-notes.json' });
  archive.append(jsonl(handouts), { name: 'handouts.json' });

  await archive.finalize();
  return done;
}

function jsonl(rows: unknown[] | null): string {
  if (!rows || rows.length === 0) return '';
  return rows.map((r) => JSON.stringify(r, jsonReplacer)).join('\n') + '\n';
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}
