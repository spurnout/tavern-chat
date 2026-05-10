import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Swords } from 'lucide-react';
import type { Campaign, CampaignSession } from '@tavern/shared';
import { api } from '../lib/api-client.js';

export function CampaignsPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    setLoading(true);
    api<Campaign[]>(`/servers/${serverId}/campaigns`)
      .then((c) => {
        if (!cancelled) setCampaigns(c);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  if (!serverId) return <div className="p-12">Pick a server.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-tavern-oak px-4 py-3">
        <Swords size={16} className="text-tavern-mist" />
        <span className="font-semibold">Campaigns</span>
      </header>
      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? <p className="text-tavern-mist">Loading…</p> : null}
        {error ? <p className="text-red-400">{error}</p> : null}
        {!loading && campaigns.length === 0 ? (
          <p className="col-span-full text-tavern-mist">
            No campaigns yet. The server admin can create one via the API:{' '}
            <code className="font-mono text-xs">POST /api/servers/{serverId}/campaigns</code>.
          </p>
        ) : null}
        {campaigns.map((c) => (
          <CampaignCard key={c.id} campaign={c} />
        ))}
      </div>
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: Campaign }): JSX.Element {
  const [sessions, setSessions] = useState<CampaignSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    api<CampaignSession[]>(`/campaigns/${campaign.id}/sessions`)
      .then((s) => {
        if (!cancelled) setSessions(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [campaign.id]);

  return (
    <div className="card space-y-3">
      <div>
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-semibold">{campaign.name}</h3>
          <span className="text-xs text-tavern-mist">{campaign.status}</span>
        </div>
        {campaign.gameSystem ? (
          <p className="text-xs uppercase tracking-wider text-tavern-mead">{campaign.gameSystem}</p>
        ) : null}
      </div>
      {campaign.description ? (
        <p className="text-sm text-tavern-parchment">{campaign.description}</p>
      ) : null}
      {campaign.safetyBoundaries.length > 0 ? (
        <div className="rounded border border-tavern-oak bg-tavern-ink p-2 text-xs">
          <div className="mb-1 uppercase tracking-wider text-tavern-mist">Safety lines & veils</div>
          <ul className="space-y-0.5">
            {campaign.safetyBoundaries.map((b) => (
              <li key={b.topic}>
                <strong>{b.topic}:</strong>{' '}
                <span className="text-tavern-mist">{b.action.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <div className="text-xs uppercase tracking-wider text-tavern-mist">Sessions</div>
        {sessions.length === 0 ? (
          <div className="text-sm text-tavern-mist">No sessions yet.</div>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {sessions.slice(0, 4).map((s) => (
              <li key={s.id} className="flex justify-between">
                <span className="truncate">{s.title}</span>
                <span className="text-xs text-tavern-mist">
                  {s.scheduledStart
                    ? new Date(s.scheduledStart).toLocaleDateString()
                    : 'unscheduled'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
