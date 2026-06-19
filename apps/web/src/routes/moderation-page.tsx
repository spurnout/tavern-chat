import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Shield } from 'lucide-react';
import { AuditTab } from '../components/moderation/AuditTab.js';
import { ReportsTab } from '../components/moderation/ReportsTab.js';
import { Tabs, TabList, Tab, TabPanel } from '../components/Tabs.js';

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
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} asChild>
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex flex-wrap items-center gap-2 border-b border-subtle px-4 py-3">
          <Shield size={16} className="text-fg-muted" />
          <span className="font-serif font-medium">Moderation</span>
          <TabList className="ml-auto text-xs" aria-label="Moderation sections">
            <Tab value="queue">Reports</Tab>
            <Tab value="audit">Audit log</Tab>
          </TabList>
        </header>
        <div className="p-6">
          <TabPanel value="queue">
            <ReportsTab serverId={serverId} />
          </TabPanel>
          <TabPanel value="audit">
            <AuditTab serverId={serverId} />
          </TabPanel>
        </div>
      </div>
    </Tabs>
  );
}
