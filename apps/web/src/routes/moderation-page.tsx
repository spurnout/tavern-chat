import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Shield } from 'lucide-react';
import { AuditTab } from '../components/moderation/AuditTab.js';
import { ReportsTab } from '../components/moderation/ReportsTab.js';

type Tab = 'queue' | 'audit';

export function ModerationPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  // Deep-linkable initial tab — the command palette routes "Open the audit
  // log…" here with `?tab=audit`.
  const initialTab: Tab =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('tab') === 'audit'
      ? 'audit'
      : 'queue';
  const [tab, setTab] = useState<Tab>(initialTab);

  if (!serverId) return <div className="p-12">Pick a tavern.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Shield size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Moderation</span>
        <div className="ml-auto flex gap-1 text-xs" role="tablist" aria-label="Moderation sections">
          <TabButton active={tab === 'queue'} onClick={() => setTab('queue')}>
            Reports
          </TabButton>
          <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
            Audit log
          </TabButton>
        </div>
      </header>
      <div className="p-6">
        {tab === 'queue' ? (
          <ReportsTab serverId={serverId} />
        ) : (
          <AuditTab serverId={serverId} />
        )}
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
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded px-2 py-1 ${
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
      }`}
    >
      {children}
    </button>
  );
}
