import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface PollOption {
  id: string;
  label: string;
  position: number;
  voteCount: number;
}

interface PollDto {
  id: string;
  messageId: string;
  question: string;
  multiChoice: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closedAt: string | null;
  createdBy: string;
  createdAt: string;
  options: PollOption[];
  myVotes: string[];
}

interface Props {
  pollId: string;
}

export function PollMessage({ pollId }: Props): JSX.Element {
  const [poll, setPoll] = useState<PollDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<PollDto>(`/polls/${pollId}`)
      .then((p) => {
        if (!cancelled) setPoll(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pollId]);

  async function vote(optionId: string): Promise<void> {
    if (!poll) return;
    setBusy(true);
    const already = poll.myVotes.includes(optionId);
    try {
      if (already) {
        await api<PollDto>(`/polls/${pollId}/vote/${optionId}`, { method: 'DELETE' }).then(setPoll);
      } else {
        await api<PollDto>(`/polls/${pollId}/vote`, {
          method: 'POST',
          body: { optionId },
        }).then(setPoll);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Vote failed');
    } finally {
      setBusy(false);
    }
  }

  if (!poll) {
    return <div className="rounded border border-subtle bg-surface px-3 py-2 text-sm text-fg-muted">Loading poll…</div>;
  }
  const total = poll.options.reduce((sum, o) => sum + o.voteCount, 0);
  const closed = !!poll.closedAt || (poll.closesAt !== null && new Date(poll.closesAt) <= new Date());

  return (
    <div className="rounded border border-subtle bg-surface p-3 text-sm">
      <p className="font-medium">{poll.question}</p>
      <p className="mt-1 text-xs text-fg-muted">
        {poll.multiChoice ? 'Multiple choice' : 'Single choice'}
        {poll.anonymous ? ' · Anonymous' : ''}
        {closed ? ' · Closed' : poll.closesAt ? ` · Closes ${new Date(poll.closesAt).toLocaleString()}` : ''}
      </p>
      <ul className="mt-2 space-y-1">
        {poll.options.map((o) => {
          const pct = total === 0 ? 0 : Math.round((o.voteCount / total) * 100);
          const mine = poll.myVotes.includes(o.id);
          return (
            <li key={o.id}>
              <button
                type="button"
                disabled={busy || closed}
                onClick={() => void vote(o.id)}
                className={`relative flex w-full items-center overflow-hidden rounded border px-2 py-1 text-left ${
                  mine ? 'border-ember bg-tint-ember' : 'border-subtle hover:bg-raised'
                }`}
              >
                <span
                  aria-hidden
                  className="absolute inset-y-0 left-0 bg-tint-fg-04"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative flex-1">{o.label}</span>
                <span className="relative font-mono text-xs text-fg-muted">
                  {o.voteCount} · {pct}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-fg-muted">
        {total} vote{total === 1 ? '' : 's'}
      </p>
    </div>
  );
}
