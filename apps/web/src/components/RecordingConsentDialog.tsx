import { useEffect, useState } from 'react';
import { Modal } from './Modal.js';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { onRecordingConsentRequest } from '../lib/voice-events.js';

interface Props {
  channelId: string;
  /** The local user's id, so we can hide the dialog when they are the proposer. */
  meId: string | null;
}

/**
 * Wave 3 #32 — consent dialog.
 *
 * Subscribes to `RECORDING_CONSENT_REQUEST` and opens a modal asking the
 * local user to allow or deny recording. The user's response goes back
 * over `POST /voice/:channelId/recording/consent { consent: boolean }`,
 * which the server fans out as `RECORDING_CONSENT_UPDATE`. The host's
 * `RecordingControls` reads those to decide when to enable "Start".
 *
 * Open is event-driven; the dialog does NOT poll. Closing without
 * responding sends an implicit Deny so the host's state machine doesn't
 * hang waiting forever.
 */
export function RecordingConsentDialog({ channelId, meId }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [proposer, setProposer] = useState<string>('');

  useEffect(() => {
    const off = onRecordingConsentRequest((p) => {
      if (p.channelId !== channelId) return;
      // The host who proposed already knows; no need to show them their
      // own consent dialog.
      if (p.proposerUserId === meId) return;
      setProposer(p.proposerUserId);
      setOpen(true);
    });
    return off;
  }, [channelId, meId]);

  async function respond(consent: boolean): Promise<void> {
    setOpen(false);
    try {
      await api(`/voice/${channelId}/recording/consent`, {
        method: 'POST',
        body: { consent },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send response');
    }
  }

  // Closing the modal via the X is equivalent to denying — keeps the
  // host's wait-for-everyone state machine honest.
  function handleOpenChange(next: boolean): void {
    if (!next && open) {
      void respond(false);
    } else {
      setOpen(next);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title="Recording requested"
      description="Someone in the room wants to record this session. Your consent is required."
    >
      <div className="space-y-3 text-sm">
        <p>
          <span className="font-medium">{proposer.slice(0, 8)}…</span> is asking to record. The
          recording will capture audio from everyone in the room — including you.
        </p>
        <p className="text-fg-muted">
          If you allow, the host will start the recording once everyone has agreed. You can leave
          the room at any time to stop it.
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => void respond(false)}>
            Deny
          </button>
          <button type="button" className="btn-primary" onClick={() => void respond(true)}>
            Allow
          </button>
        </div>
      </div>
    </Modal>
  );
}
