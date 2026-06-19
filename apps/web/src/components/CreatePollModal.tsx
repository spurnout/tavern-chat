import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from './Modal.js';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface Props {
  channelId: string;
  initialQuestion?: string;
  initialOptions?: string[];
  onClose: () => void;
}

export function CreatePollModal({
  channelId,
  initialQuestion = '',
  initialOptions = ['', ''],
  onClose,
}: Props): JSX.Element {
  const [question, setQuestion] = useState(initialQuestion);
  const [options, setOptions] = useState<string[]>(initialOptions.length >= 2 ? initialOptions : ['', '']);
  const [multiChoice, setMultiChoice] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [closesIn, setClosesIn] = useState<string>(''); // empty = no deadline
  const [busy, setBusy] = useState(false);

  function setOption(i: number, value: string): void {
    setOptions((s) => s.map((v, idx) => (idx === i ? value : v)));
  }
  function addOption(): void {
    if (options.length >= 10) return;
    setOptions((s) => [...s, '']);
  }
  function removeOption(i: number): void {
    if (options.length <= 2) return;
    setOptions((s) => s.filter((_, idx) => idx !== i));
  }

  async function submit(): Promise<void> {
    const cleanedOptions = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || cleanedOptions.length < 2) {
      toast.error('A poll needs a question and at least two options.');
      return;
    }
    const closesAt = closesIn ? new Date(Date.now() + parseDuration(closesIn) * 1000).toISOString() : null;
    setBusy(true);
    try {
      await api(`/channels/${channelId}/polls`, {
        method: 'POST',
        body: {
          question: question.trim(),
          options: cleanedOptions,
          multiChoice,
          anonymous,
          closesAt,
        },
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create poll');
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
      title="New poll"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            className="btn-primary"
            disabled={busy}
          >
            Create
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-fg-muted">Question</span>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="input mt-1 w-full"
            placeholder="What are we playing Friday?"
            maxLength={280}
            autoFocus
          />
        </label>
        <div>
          <span className="text-sm text-fg-muted">Options</span>
          <ul className="mt-1 space-y-1">
            {options.map((opt, i) => (
              <li key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                  placeholder={`Option ${i + 1}`}
                  maxLength={120}
                  className="input flex-1"
                />
                {options.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    className="rounded p-1 text-fg-muted hover:bg-raised"
                    aria-label="Remove option"
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {options.length < 10 ? (
            <button
              type="button"
              onClick={addOption}
              className="mt-2 inline-flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-raised"
            >
              <Plus size={12} /> Add option
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={multiChoice}
              onChange={(e) => setMultiChoice(e.target.checked)}
            />
            Allow multiple choices
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
            />
            Anonymous
          </label>
          <label className="flex items-center gap-2">
            <span className="text-fg-muted">Closes in</span>
            <select
              value={closesIn}
              onChange={(e) => setClosesIn(e.target.value)}
              className="input"
            >
              <option value="">No deadline</option>
              <option value="1h">1 hour</option>
              <option value="6h">6 hours</option>
              <option value="1d">1 day</option>
              <option value="7d">7 days</option>
            </select>
          </label>
        </div>
      </div>
    </Modal>
  );
}

function parseDuration(s: string): number {
  // Seconds
  const m = /^(\d+)([hdm])$/.exec(s);
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
