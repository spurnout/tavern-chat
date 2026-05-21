import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { FederatedInvitePreview } from '@tavern/shared';
import { acceptFederatedInvite, ApiError, previewFederatedInvite } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { Modal } from './Modal.js';

interface Props {
  /** The peer host that minted the invite, e.g. `a.example`. */
  host: string;
  /** The invite code from the link. */
  code: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Federation Phase 4 / P4-16 — preview modal shown when the user follows a
 * federated invite link. Fetches the preview via our API passthrough,
 * displays the den name + host + inviter + room count, and accepts the
 * invite on confirmation.
 *
 * Voice: "den" (not "server"), "room" (not "channel"), sentence case
 * everywhere. The primary action mirrors the local create-den CTA — "pull
 * up a chair" — to keep the federation flow feeling like a continuation of
 * the same world rather than something foreign.
 *
 * Close behaviour: clicking outside / pressing Escape / hitting Cancel all
 * dismiss the modal. The accept action navigates to the resulting mirror
 * den on success and then closes — the navigation is intentionally inside
 * the success branch so the modal stays visible if the request errors,
 * letting the user see the error message and retry.
 */
export function FederatedInvitePreviewModal({
  host,
  code,
  open,
  onOpenChange,
}: Props): JSX.Element {
  const [preview, setPreview] = useState<FederatedInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const navigate = useNavigate();

  // Fetch the preview each time the modal opens with new (host, code). We
  // re-fetch on re-open so a stale preview can't leak between two separate
  // invite acceptances in the same session.
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewFederatedInvite(host, code)
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
      })
      .catch((err) => {
        if (cancelled) return;
        // The passthrough API maps the home's error codes onto our standard
        // envelope. NOT_FOUND, INVALID_INVITE, PERMISSION_DENIED each have
        // their own message that's already user-friendly enough to surface
        // directly; we don't translate further.
        setError(err instanceof ApiError ? err.message : 'Could not load this invite.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, host, code]);

  async function handleAccept(): Promise<void> {
    if (!preview || accepting) return;
    setAccepting(true);
    try {
      const result = await acceptFederatedInvite(code, host);
      // The gateway broadcasts SERVER_ADD on the next tick — the realtime
      // store will splice it into serversById. We can navigate optimistically
      // using the resolved id returned in the body; the route will hydrate
      // its own per-server channel list on mount.
      onOpenChange(false);
      await navigate({
        to: '/app/servers/$serverId',
        params: { serverId: result.serverId },
      });
      if (result.alreadyMember) {
        toast.info(`You're already in ${preview.name}.`);
      } else {
        toast.success(`Pulled up a chair in ${preview.name}.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join this den.');
    } finally {
      setAccepting(false);
    }
  }

  // Header copy depends on whether we have the preview yet. Loading / error
  // states share the same modal chrome so the user keeps spatial context.
  const title = preview ? `Join ${preview.name}?` : 'Federated invite';
  const description = preview
    ? `Hosted on ${host}, invited by ${preview.inviterRemoteUserId}`
    : undefined;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <button
            className="btn-ghost"
            onClick={() => onOpenChange(false)}
            disabled={accepting}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => void handleAccept()}
            disabled={!preview || accepting || loading}
          >
            {accepting ? 'Joining…' : 'Pull up a chair'}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="text-sm text-fg-muted">Loading invite…</p>
      ) : preview ? (
        <div className="space-y-3 text-sm">
          {preview.description ? (
            <p className="text-fg">{preview.description}</p>
          ) : null}
          <p className="text-fg-muted">
            {preview.channelCount} {preview.channelCount === 1 ? 'room' : 'rooms'}
          </p>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
    </Modal>
  );
}
