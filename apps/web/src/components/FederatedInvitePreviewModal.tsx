import { useEffect, useRef, useState } from 'react';
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
 * displays the tavern name + host + inviter + room count, and accepts the
 * invite on confirmation.
 *
 * Voice: "tavern" (not "server"/"den"), "room" (not "channel"), sentence
 * case everywhere. The primary action mirrors the local create-tavern CTA —
 * "pull up a chair" — to keep the federation flow feeling like a continuation
 * of the same world rather than something foreign.
 *
 * Close behaviour: clicking outside / pressing Escape / hitting Cancel all
 * dismiss the modal. The accept action navigates to the resulting mirror
 * tavern on success and then closes — the navigation is intentionally inside
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
  // Synchronous in-flight guard: React batching means two clicks within the
  // same render pass both see `accepting === false` and both queue the
  // setState. Refs flip immediately, so the second click bails before
  // firing the second acceptFederatedInvite POST.
  const inFlightRef = useRef(false);
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
    if (!preview || accepting || inFlightRef.current) return;
    inFlightRef.current = true;
    setAccepting(true);
    try {
      const result = await acceptFederatedInvite(code, host);
      // The gateway broadcasts SERVER_ADD on the next tick — the realtime
      // store will splice it into serversById. We can navigate optimistically
      // using the resolved id returned in the body; the route will hydrate
      // its own per-server channel list on mount. Navigate FIRST, then close:
      // a navigate failure should leave the modal open with the error
      // visible, not strand the user on the invite page with no signal.
      await navigate({
        to: '/app/servers/$serverId',
        params: { serverId: result.serverId },
      });
      onOpenChange(false);
      if (result.alreadyMember) {
        toast.info(`You're already in ${preview.name}.`);
      } else {
        toast.success(`Pulled up a chair in ${preview.name}.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join this tavern.');
    } finally {
      inFlightRef.current = false;
      setAccepting(false);
    }
  }

  // Header copy depends on whether we have the preview yet. Loading / error
  // states share the same modal chrome so the user keeps spatial context.
  const title = preview ? `Join ${preview.name}?` : 'Federated invite';
  const description = preview
    ? // SEC: cap remote-controlled identifier length so a hostile peer
      // can't ship a 500-char inviter ID that overflows the modal chrome.
      `Hosted on ${host}, invited by ${preview.inviterRemoteUserId.slice(0, 64)}`
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
          <div className="flex items-center gap-3">
            {preview.iconUrl ? (
              <img
                src={preview.iconUrl}
                alt=""
                className="h-12 w-12 rounded-2xl object-cover"
              />
            ) : (
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-raised font-serif text-lg font-bold text-fg">
                {preview.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <p className="font-medium text-fg">{preview.name}</p>
          </div>
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
