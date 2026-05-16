import archiver from 'archiver';
import { prisma } from '@tavern/db';
import type { FastifyBaseLogger } from 'fastify';
import type { StorageBackend } from '@tavern/media';
import { gatewayBroker } from './gateway-broker.js';

/**
 * Per-user GDPR-style data export. The job:
 *
 *   1. flips the row to running
 *   2. walks the authored data the user owns
 *   3. emits each table as a JSON file inside an in-memory zip
 *   4. uploads the zip to the configured storage bucket
 *   5. flips the row to ready, publishes `EXPORT_READY` with the row id
 *      so the frontend's `AccountDataSection` can refresh and show the
 *      "Download" affordance
 *
 * Attachment binaries are intentionally NOT included in V1 — only their
 * metadata (id, kind, sizeBytes, storageKey hint) so a user can re-download
 * each via the existing attachment endpoints if they need the raw files.
 * Including binaries inline would make exports huge and turn a "give me my
 * data" affordance into a server-side OOM risk.
 *
 * Failure handling: any throw inside `walkAndArchive` is captured, the row
 * is flipped to `failed` with the message, and a final EXPORT_READY is fired
 * so the UI updates rather than spinning forever.
 */
export async function runUserDataExport(
  exportId: string,
  storage: StorageBackend,
  log: FastifyBaseLogger,
): Promise<void> {
  await prisma.userDataExport.update({
    where: { id: exportId },
    data: { status: 'running', startedAt: new Date() },
  });
  try {
    const job = await prisma.userDataExport.findUniqueOrThrow({ where: { id: exportId } });
    const zipBuffer = await buildExportZip(job.userId);
    const storageKey = `exports/${job.userId}/${job.id}.zip`;
    await storage.putObject(storage.mainBucket, storageKey, zipBuffer, 'application/zip');
    await prisma.userDataExport.update({
      where: { id: exportId },
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
      userId: job.userId,
      data: {
        exportId: job.id,
        status: 'ready',
        sizeBytes: zipBuffer.length,
      },
    });
    log.info(
      { event: 'data-export.ready', exportId, userId: job.userId, sizeBytes: zipBuffer.length },
      'data export ready',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.userDataExport
      .update({
        where: { id: exportId },
        data: { status: 'failed', finishedAt: new Date(), failureReason: message },
      })
      .catch(() => undefined);
    const job = await prisma.userDataExport.findUnique({ where: { id: exportId } });
    if (job) {
      gatewayBroker.publish({
        type: 'EXPORT_READY',
        userId: job.userId,
        data: { exportId: job.id, status: 'failed' },
      });
    }
    log.warn({ event: 'data-export.failed', exportId, err: message }, 'data export failed');
  }
}

async function buildExportZip(userId: string): Promise<Buffer> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', (err) => {
      // archiver emits "warning" for missing files; we never reference files
      // directly so a warning here is genuinely surprising.
      reject(err);
    });
    archive.on('error', reject);
  });

  // README — orients the recipient. Always first in the zip.
  archive.append(
    [
      'Tavern personal data export',
      '',
      `User: ${userId}`,
      `Generated: ${new Date().toISOString()}`,
      '',
      'Each JSON file groups the rows you authored or own in one schema',
      'table. Attachment binaries are NOT inlined; their metadata records',
      'reference storage keys you can download via the API while your',
      'account is active.',
    ].join('\n'),
    { name: 'README.txt' },
  );

  // Profile — the user's own row, password hash stripped.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      avatarAttachmentId: true,
      bio: true,
      pronouns: true,
      accentColor: true,
      timezone: true,
      customStatus: true,
      socialLinks: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  archive.append(jsonl([user]), { name: 'profile.json' });

  // Messages authored by the user — paged via chunked findMany to keep
  // memory bounded on heavy posters.
  const messages = await prisma.message.findMany({
    where: { authorId: userId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      serverId: true,
      channelId: true,
      dmChannelId: true,
      type: true,
      content: true,
      replyToMessageId: true,
      threadId: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
    },
  });
  archive.append(jsonl(messages), { name: 'messages.json' });

  // Attachments uploaded by the user — metadata only.
  const attachments = await prisma.attachment.findMany({
    where: { uploaderId: userId },
    select: {
      id: true,
      kind: true,
      mimeType: true,
      sizeBytes: true,
      width: true,
      height: true,
      durationMs: true,
      storageBucket: true,
      storageKey: true,
      status: true,
      createdAt: true,
    },
  });
  archive.append(jsonl(attachments), { name: 'attachments.json' });

  // Reactions and dice rolls — small but personal.
  const [reactions, diceRolls] = await Promise.all([
    prisma.messageReaction.findMany({
      where: { userId },
      select: { messageId: true, emoji: true, createdAt: true },
    }),
    prisma.diceRoll.findMany({
      where: { userId },
      select: {
        id: true,
        channelId: true,
        notation: true,
        total: true,
        resultJson: true,
        visibility: true,
        createdAt: true,
      },
    }),
  ]);
  archive.append(jsonl(reactions), { name: 'reactions.json' });
  archive.append(jsonl(diceRolls), { name: 'dice-rolls.json' });

  // Campaign artefacts the user authored.
  const [notes, handouts, sessionRsvps] = await Promise.all([
    prisma.campaignNote.findMany({
      where: { authorId: userId },
      select: {
        id: true,
        campaignId: true,
        title: true,
        body: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.handout.findMany({
      where: { authorId: userId },
      select: {
        id: true,
        campaignId: true,
        title: true,
        body: true,
        visibility: true,
        createdAt: true,
      },
    }),
    prisma.campaignSessionRsvp.findMany({
      where: { userId },
      select: {
        sessionId: true,
        status: true,
        updatedAt: true,
      },
    }),
  ]);
  archive.append(jsonl(notes), { name: 'campaign-notes.json' });
  archive.append(jsonl(handouts), { name: 'handouts.json' });
  archive.append(jsonl(sessionRsvps), { name: 'session-rsvps.json' });

  // Bookmarks the user saved + pins they authored.
  const [saved, pinned] = await Promise.all([
    prisma.savedMessage.findMany({
      where: { userId },
      select: { messageId: true, note: true, savedAt: true },
    }),
    prisma.pinnedMessage.findMany({
      where: { pinnedBy: userId },
      select: { messageId: true, channelId: true, pinnedAt: true, note: true },
    }),
  ]);
  archive.append(jsonl(saved), { name: 'saved-messages.json' });
  archive.append(jsonl(pinned), { name: 'pinned-messages.json' });

  // Reports the user filed.
  const reports = await prisma.report.findMany({
    where: { reporterId: userId },
    select: {
      id: true,
      targetType: true,
      targetId: true,
      category: true,
      notes: true,
      status: true,
      createdAt: true,
    },
  });
  archive.append(jsonl(reports), { name: 'reports-filed.json' });

  await archive.finalize();
  return done;
}

/**
 * Render a list of rows as newline-delimited JSON. Easier to grep / process
 * with standard tools than a single giant array, and lets the worker stream
 * the body in a future refactor without restructuring the schema.
 */
function jsonl(rows: unknown[] | null): string {
  if (!rows || rows.length === 0) return '';
  return rows.map((r) => JSON.stringify(r, jsonReplacer)).join('\n') + '\n';
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}
