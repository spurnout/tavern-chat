import { useState } from 'react';
import type { ReportCategory, ReportTargetType } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { Modal } from './Modal.js';

interface Props {
  targetType: ReportTargetType;
  targetId: string;
  serverId?: string | null;
  onClose: () => void;
}

const CATEGORIES: Array<{ value: ReportCategory; label: string }> = [
  { value: 'spam_or_raid', label: 'Spam or raid' },
  { value: 'stalking_swatting_or_targeted_harassment', label: 'Targeted harassment / stalking' },
  { value: 'doxxing_or_private_information', label: 'Doxxing / private info' },
  { value: 'credible_threat_or_violent_coordination', label: 'Credible threat / violence' },
  { value: 'malware_phishing_or_credential_theft', label: 'Malware / phishing' },
  { value: 'fraud_or_scam', label: 'Fraud / scam' },
  { value: 'illegal_marketplace_or_trafficking', label: 'Illegal marketplace / trafficking' },
  { value: 'non_consensual_intimate_material', label: 'Non-consensual intimate material' },
  { value: 'suspected_child_exploitation_or_csam', label: 'Suspected child exploitation / CSAM' },
  { value: 'policy_evasion', label: 'Policy evasion' },
  { value: 'other_serious_abuse', label: 'Other serious abuse' },
];

export function ReportDialog(props: Props): JSX.Element {
  const [category, setCategory] = useState<ReportCategory>('spam_or_raid');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api('/reports', {
        method: 'POST',
        body: {
          targetType: props.targetType,
          targetId: props.targetId,
          serverId: props.serverId ?? undefined,
          category,
          notes: notes.trim() || undefined,
        },
      });
      setSubmitted(true);
      setTimeout(props.onClose, 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit report');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && props.onClose()}
      title="Report content"
      description="Reports go to your tavern's moderators. Pick the most specific category that applies."
      widthClass="w-[min(95vw,440px)]"
      footer={
        submitted ? undefined : (
          <>
            <button type="button" className="btn-ghost" onClick={props.onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? 'Submitting…' : 'Submit report'}
            </button>
          </>
        )
      }
    >
      {submitted ? (
        <p className="text-sm text-mead">Thanks — your report was filed.</p>
      ) : (
        <>
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Category</span>
            <select
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value as ReportCategory)}
              disabled={busy}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-3 block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Notes (optional)</span>
            <textarea
              className="input min-h-[6rem]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              maxLength={2000}
              placeholder="Anything else moderators should know?"
            />
          </label>
          {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        </>
      )}
    </Modal>
  );
}
