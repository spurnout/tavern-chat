import { useEffect, useState } from 'react';
import type { LocalParticipant, RemoteParticipant } from 'livekit-client';
import { Users, X } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

type ParticipantAny = LocalParticipant | RemoteParticipant;

interface BreakoutRow {
  id: string;
  parentChannelId: string;
  name: string;
  livekitRoom: string;
  endsAt: string | null;
  createdBy: string;
  members: Array<{ userId: string; joinedAt: string | null }>;
  createdAt: string;
}

interface Props {
  channelId: string;
  participants: ParticipantAny[];
  onClose: () => void;
}

/**
 * Wave 3 #29 — Host-facing breakout management.
 *
 * The panel shows two states:
 *  - No active breakouts: a member picker (each currently-in-the-room
 *    participant gets a "Group N" select) + a count input + an "Open"
 *    button that POSTs `/voice/:channelId/breakouts` with the assignments.
 *  - Active breakouts: a single "End breakouts" button that POSTs
 *    `/voice/:channelId/breakouts/end-all`.
 *
 * Picker pulls candidate userIds + display names from the live LiveKit
 * participant set rather than a separate server-members slice — the
 * realtime store doesn't expose `membersByServer`, and the breakouts
 * server route accepts arbitrary userIds the host has rights to assign.
 */
export function BreakoutsPanel({ channelId, participants, onClose }: Props): JSX.Element {
  const [active, setActive] = useState<BreakoutRow[]>([]);
  const [groupCount, setGroupCount] = useState(2);
  // userId -> 0-based group index, or -1 for unassigned.
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const rows = await api<BreakoutRow[]>(`/voice/${channelId}/breakouts`);
      setActive(rows);
    } catch {
      // Keep last state on transient errors; the panel reopens cleanly.
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function createGroups(): Promise<void> {
    const groups: Array<{ name: string; memberIds: string[] }> = [];
    for (let i = 0; i < groupCount; i++) {
      const memberIds = participants
        .filter((p) => assignments[p.identity] === i)
        .map((p) => p.identity);
      if (memberIds.length === 0) {
        toast.error(`Group ${i + 1} has no one assigned.`);
        return;
      }
      groups.push({ name: `Group ${i + 1}`, memberIds });
    }
    setBusy(true);
    try {
      await api(`/voice/${channelId}/breakouts`, {
        method: 'POST',
        body: { groups },
      });
      toast.success('Breakouts opened.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not open breakouts');
    } finally {
      setBusy(false);
    }
  }

  async function endAll(): Promise<void> {
    setBusy(true);
    try {
      await api(`/voice/${channelId}/breakouts/end-all`, { method: 'POST' });
      await refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not end breakouts');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="absolute inset-x-0 bottom-full z-30 mb-2 w-[min(95vw,520px)] rounded border border-subtle bg-surface p-3 shadow-lg">
      <header className="mb-2 flex items-center gap-2">
        <Users size={14} />
        <h2 className="font-serif text-sm">Breakouts</h2>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 hover:bg-raised"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </header>
      {active.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">
            {active.length} active breakout{active.length === 1 ? '' : 's'}.
          </p>
          <ul className="space-y-1 rounded border border-subtle bg-canvas p-2 text-sm">
            {active.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{row.name}</span>
                <span className="text-xs text-fg-muted">
                  {row.members.length} member{row.members.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void endAll()}
            disabled={busy}
          >
            End breakouts
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            Number of groups
            <input
              type="number"
              min={2}
              max={20}
              value={groupCount}
              onChange={(e) =>
                setGroupCount(Math.max(2, Math.min(20, Number(e.target.value) || 2)))
              }
              className="input w-20"
              disabled={busy}
            />
          </label>
          <div className="max-h-60 space-y-1 overflow-y-auto rounded border border-subtle p-2">
            {participants.length === 0 ? (
              <p className="text-sm text-fg-muted">No one is in the room yet.</p>
            ) : (
              participants.map((p) => {
                const displayName = p.name ?? p.identity.slice(0, 10);
                return (
                  <div
                    key={p.identity}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate">{displayName}</span>
                    <select
                      value={assignments[p.identity] ?? -1}
                      onChange={(e) =>
                        setAssignments((prev) => ({
                          ...prev,
                          [p.identity]: Number(e.target.value),
                        }))
                      }
                      className="input"
                      disabled={busy}
                    >
                      <option value={-1}>—</option>
                      {Array.from({ length: groupCount }).map((_, i) => (
                        <option key={i} value={i}>{`Group ${i + 1}`}</option>
                      ))}
                    </select>
                  </div>
                );
              })
            )}
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void createGroups()}
            disabled={busy || participants.length === 0}
          >
            Open breakouts
          </button>
        </div>
      )}
    </div>
  );
}
