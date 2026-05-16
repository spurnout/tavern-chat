import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Plus, Swords } from 'lucide-react';
import type { Campaign } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { CreateCampaignModal } from '../components/CreateCampaignModal.js';
import { SessionsTab } from '../components/campaigns/SessionsTab.js';
import { NotesTab } from '../components/campaigns/NotesTab.js';
import { HandoutsTab } from '../components/campaigns/HandoutsTab.js';
import { SafetyTab } from '../components/campaigns/SafetyTab.js';
import { GmScreenTab } from '../components/campaigns/GmScreenTab.js';
import { DecksPanel } from '../components/DecksPanel.js';
import { CharactersPanel } from '../components/CharactersPanel.js';
import { NpcRosterPanel } from '../components/NpcRosterPanel.js';
import { RandomTablesPanel } from '../components/RandomTablesPanel.js';

export function CampaignsPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await api<Campaign[]>(`/servers/${serverId}/campaigns`);
      setCampaigns(list);
      if (!activeId && list[0]) setActiveId(list[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load campaigns');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const active = campaigns.find((c) => c.id === activeId) ?? null;

  if (!serverId) return <div className="p-12">Pick a den.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Swords size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Campaigns</span>
        <button
          type="button"
          className="btn-primary ml-auto text-sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} className="mr-1" /> New campaign
        </button>
      </header>
      <div className="grid flex-1 grid-cols-1 gap-0 lg:grid-cols-[280px_1fr]">
        <aside className="border-b border-subtle p-3 lg:border-b-0 lg:border-r">
          {loading ? <p className="text-fg-muted">Loading…</p> : null}
          {error ? <p className="text-danger">{error}</p> : null}
          {!loading && campaigns.length === 0 ? (
            <p className="text-sm text-fg-muted">No campaigns yet.</p>
          ) : null}
          <ul className="space-y-1">
            {campaigns.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                    activeId === c.id ? 'bg-raised' : 'hover:bg-raised'
                  }`}
                >
                  <div className="font-serif font-medium">{c.name}</div>
                  <div className="font-mono text-xs text-fg-muted">
                    {c.gameSystem ?? '—'} · {c.status}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="overflow-y-auto p-6">
          {active ? <CampaignDetail campaign={active} /> : null}
        </main>
      </div>
      <CreateCampaignModal
        serverId={serverId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(c) => {
          setCampaigns((all) => [c, ...all]);
          setActiveId(c.id);
        }}
      />
    </div>
  );
}

function CampaignDetail({ campaign }: { campaign: Campaign }): JSX.Element {
  type CampaignTab =
    | 'sessions'
    | 'notes'
    | 'handouts'
    | 'characters'
    | 'npcs'
    | 'tables'
    | 'safety'
    | 'decks'
    | 'gm';
  const [tab, setTab] = useState<CampaignTab>('sessions');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header>
        <h2 className="font-serif text-2xl font-medium">{campaign.name}</h2>
        {campaign.description ? (
          <p className="mt-1 text-sm text-fg">{campaign.description}</p>
        ) : null}
      </header>
      {campaign.safetyBoundaries.length > 0 ? (
        <div className="rounded border border-subtle bg-surface p-3 text-xs">
          <div className="mb-1 uppercase tracking-wider text-fg-muted">Safety lines &amp; veils</div>
          <ul className="space-y-0.5">
            {campaign.safetyBoundaries.map((b) => (
              <li key={b.topic}>
                <strong>{b.topic}:</strong>{' '}
                <span className="text-fg-muted">{b.action.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-1 text-xs">
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
          Sessions
        </TabButton>
        <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>
          Notes
        </TabButton>
        <TabButton active={tab === 'handouts'} onClick={() => setTab('handouts')}>
          Handouts
        </TabButton>
        <TabButton active={tab === 'characters'} onClick={() => setTab('characters')}>
          Characters
        </TabButton>
        <TabButton active={tab === 'npcs'} onClick={() => setTab('npcs')}>
          NPCs
        </TabButton>
        <TabButton active={tab === 'tables'} onClick={() => setTab('tables')}>
          Tables
        </TabButton>
        <TabButton active={tab === 'safety'} onClick={() => setTab('safety')}>
          Safety
        </TabButton>
        <TabButton active={tab === 'decks'} onClick={() => setTab('decks')}>
          Decks
        </TabButton>
        <TabButton active={tab === 'gm'} onClick={() => setTab('gm')}>
          GM screen
        </TabButton>
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'sessions' ? <SessionsTab campaign={campaign} /> : null}
        {tab === 'notes' ? <NotesTab campaign={campaign} /> : null}
        {tab === 'handouts' ? <HandoutsTab campaign={campaign} /> : null}
        {tab === 'characters' ? <CharactersPanel campaignId={campaign.id} /> : null}
        {tab === 'npcs' ? <NpcRosterPanel campaignId={campaign.id} /> : null}
        {tab === 'tables' ? (
          <RandomTablesPanel serverId={campaign.serverId} campaignId={campaign.id} />
        ) : null}
        {tab === 'safety' ? <SafetyTab campaign={campaign} /> : null}
        {tab === 'decks' ? (
          <DecksPanel
            serverId={campaign.serverId}
            {...(campaign.defaultChannelId ? { channelId: campaign.defaultChannelId } : {})}
          />
        ) : null}
        {tab === 'gm' ? <GmScreenTab campaign={campaign} onJumpTab={setTab} /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
      }`}
    >
      {children}
    </button>
  );
}
