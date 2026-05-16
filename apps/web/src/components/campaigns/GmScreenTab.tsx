import { useState } from 'react';
import { Dice5, ScrollText, Sparkles, Users } from 'lucide-react';
import type { Campaign } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';

interface QuickRoll {
  label: string;
  notation: string;
}

const QUICK_ROLLS: QuickRoll[] = [
  { label: 'd4', notation: '1d4' },
  { label: 'd6', notation: '1d6' },
  { label: 'd8', notation: '1d8' },
  { label: 'd10', notation: '1d10' },
  { label: 'd12', notation: '1d12' },
  { label: 'd20', notation: '1d20' },
  { label: 'd100', notation: '1d100' },
  { label: '2d6', notation: '2d6' },
  { label: '3d6', notation: '3d6' },
  { label: '4d6kh3', notation: '4d6kh3' },
  { label: 'd20 adv', notation: '2d20kh1' },
  { label: 'd20 dis', notation: '2d20kl1' },
];

interface RollResult {
  notation: string;
  total: number;
  label: string;
  visibility: 'public' | 'gm_only' | 'private';
  createdAt: string;
}

/**
 * Wave 3 #17 — GM screen.
 *
 * A curated GM workspace: quick dice rolls (defaulting to GM-only visibility
 * so the table doesn't see the math), with shortcut links to the other
 * GM-relevant tabs (NPCs, random tables, safety, handouts). The roll output
 * is posted into the campaign's default channel; the result also stays in a
 * scratch list at the top of this tab so the GM can scan recent throws
 * without flipping back to chat.
 */
export function GmScreenTab({
  campaign,
  onJumpTab,
}: {
  campaign: Campaign;
  onJumpTab: (tab: 'notes' | 'npcs' | 'tables' | 'safety' | 'handouts') => void;
}): JSX.Element {
  const [history, setHistory] = useState<RollResult[]>([]);
  const [visibility, setVisibility] = useState<'gm_only' | 'public' | 'private'>('gm_only');
  const [busy, setBusy] = useState(false);

  async function roll(qr: QuickRoll): Promise<void> {
    if (!campaign.defaultChannelId) {
      toast.error('This campaign has no default channel — set one in campaign settings.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<RollResult>('/dice/roll', {
        method: 'POST',
        body: {
          channelId: campaign.defaultChannelId,
          notation: qr.notation,
          visibility,
          label: qr.label,
        },
      });
      setHistory((h) => [r, ...h].slice(0, 12));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Roll failed');
    } finally {
      setBusy(false);
    }
  }

  const visLabel: Record<typeof visibility, string> = {
    gm_only: 'GM only',
    public: 'Public',
    private: 'Private',
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-center gap-2 rounded border border-subtle bg-surface p-3">
        <Dice5 size={14} className="text-fg-muted" />
        <h3 className="font-serif">Quick rolls</h3>
        <label className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
          Visibility
          <select
            className="input ml-1 h-7 px-1 py-0 text-xs"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as typeof visibility)}
            disabled={busy}
          >
            <option value="gm_only">{visLabel.gm_only}</option>
            <option value="public">{visLabel.public}</option>
            <option value="private">{visLabel.private}</option>
          </select>
        </label>
      </header>
      <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 lg:grid-cols-6">
        {QUICK_ROLLS.map((qr) => (
          <button
            key={qr.notation}
            type="button"
            onClick={() => void roll(qr)}
            disabled={busy}
            className="rounded border border-subtle bg-canvas px-2 py-2 text-sm hover:bg-raised"
            title={`Roll ${qr.notation} (${visLabel[visibility]})`}
          >
            <span className="block font-serif">{qr.label}</span>
            <span className="block text-[10px] text-fg-muted">{qr.notation}</span>
          </button>
        ))}
      </div>
      {history.length > 0 ? (
        <section>
          <h4 className="mb-1 text-xs uppercase tracking-wider text-fg-muted">Recent rolls</h4>
          <ul className="space-y-1 text-sm">
            {history.map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between rounded border border-subtle bg-canvas px-2 py-1"
              >
                <span className="font-mono">
                  {r.label ? <span className="text-fg-muted">{r.label}: </span> : null}
                  {r.notation}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-serif text-base">{r.total}</span>
                  <span className="text-[10px] uppercase tracking-wider text-fg-faint">
                    {visLabel[r.visibility]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="rounded border border-subtle bg-surface p-3">
        <h4 className="mb-2 text-xs uppercase tracking-wider text-fg-muted">Shortcuts</h4>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <button
            type="button"
            className="flex items-center gap-2 rounded border border-subtle bg-canvas px-2 py-2 hover:bg-raised"
            onClick={() => onJumpTab('npcs')}
          >
            <Users size={14} /> NPCs
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded border border-subtle bg-canvas px-2 py-2 hover:bg-raised"
            onClick={() => onJumpTab('tables')}
          >
            <ScrollText size={14} /> Tables
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded border border-subtle bg-canvas px-2 py-2 hover:bg-raised"
            onClick={() => onJumpTab('notes')}
          >
            <ScrollText size={14} /> Notes
          </button>
          <button
            type="button"
            className="flex items-center gap-2 rounded border border-subtle bg-canvas px-2 py-2 hover:bg-raised"
            onClick={() => onJumpTab('safety')}
          >
            <Sparkles size={14} /> Safety
          </button>
        </div>
      </section>
      {!campaign.defaultChannelId ? (
        <p className="rounded border border-subtle bg-canvas p-3 text-xs text-fg-muted">
          This campaign has no default channel set. Rolls will fail until one is configured in
          campaign settings.
        </p>
      ) : null}
    </div>
  );
}
