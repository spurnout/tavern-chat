/**
 * Attachment-ready event bus (FE-17).
 *
 * Single-purpose promise pump: anything that needs to wait for the worker
 * pipeline to flip an attachment to a terminal status (`ready` / `failed` /
 * `blocked` / `quarantined`) registers an `awaitTerminal(attachmentId)`
 * promise. The gateway's `ATTACHMENT_READY` dispatch handler calls
 * `resolveTerminal(attachmentId, status)` once the worker emits.
 *
 * Promises auto-time-out after the provided window. Callers MUST race
 * against a timeout themselves — the bus doesn't keep references forever.
 */

import type { AttachmentReadyPayload } from '@tavern/shared';

type TerminalStatus = AttachmentReadyPayload['status'];

interface PendingEntry {
  resolve: (status: TerminalStatus) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingEntry>();

/**
 * Wait up to `timeoutMs` for a terminal-status event for `attachmentId`.
 * Resolves with the status string; rejects with `Timed out` if no event
 * arrives before the deadline.
 */
export function awaitTerminal(
  attachmentId: string,
  timeoutMs: number,
): Promise<TerminalStatus> {
  return new Promise<TerminalStatus>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.get(attachmentId)?.resolve === wrapped) {
        pending.delete(attachmentId);
        reject(new Error('attachment-ready timeout'));
      }
    }, timeoutMs);

    const wrapped: PendingEntry['resolve'] = (status) => {
      clearTimeout(timer);
      resolve(status);
    };
    pending.set(attachmentId, { resolve: wrapped, reject });
  });
}

export function resolveTerminal(attachmentId: string, status: TerminalStatus): void {
  const entry = pending.get(attachmentId);
  if (!entry) return;
  pending.delete(attachmentId);
  entry.resolve(status);
}
