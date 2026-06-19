import { useState } from 'react';
import { Modal } from './Modal.js';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Props {
  initialText?: string;
  onClose: () => void;
}

/**
 * Schedules a personal reminder. Delivered via gateway as a mention-style
 * notification at dispatch time, so the inbox bell lights up.
 */
export function RemindModal({ initialText = '', onClose }: Props): JSX.Element {
  const [text, setText] = useState(initialText);
  const [delay, setDelay] = useState('1h');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error('A reminder needs some text.');
      return;
    }
    const seconds = parseDuration(delay);
    if (seconds <= 0) {
      toast.error('Pick how far out the reminder should fire.');
      return;
    }
    const dispatchAt = new Date(Date.now() + seconds * 1000).toISOString();
    setBusy(true);
    try {
      await api('/me/scheduled', {
        method: 'POST',
        body: {
          kind: 'reminder',
          payload: { text: trimmed },
          dispatchAt,
        },
      });
      toast.info('Reminder set.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not schedule reminder');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Remind me"
      widthClass="w-[min(95vw,400px)]"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} className="btn-primary" disabled={busy}>
            Schedule
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-fg-muted">About</span>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="input mt-1 w-full"
            placeholder="Feed the cat"
            maxLength={280}
            autoFocus
          />
        </label>
        <label className="block text-sm">
          <span className="text-fg-muted">In</span>
          <select
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            className="input mt-1 w-full"
          >
            <option value="5m">5 minutes</option>
            <option value="15m">15 minutes</option>
            <option value="1h">1 hour</option>
            <option value="6h">6 hours</option>
            <option value="1d">1 day</option>
            <option value="7d">7 days</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

function parseDuration(s: string): number {
  const m = /^(\d+)([mhd])$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm':
      return n * 60;
    case 'h':
      return n * 60 * 60;
    case 'd':
      return n * 24 * 60 * 60;
    default:
      return 0;
  }
}
