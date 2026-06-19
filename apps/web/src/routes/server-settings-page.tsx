import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Ban, Bell, Bot, DoorOpen, Globe, HeartHandshake, Settings, ShieldCheck, Smile, Tag, Users } from 'lucide-react';
import { PerTavernNotificationSettings } from '../components/PerTavernNotificationSettings.js';
import { ServerIntegrationsPanel } from '../components/ServerIntegrationsPanel.js';
import { ServerInvitesPanel } from '../components/ServerInvitesPanel.js';
import { BansPanel } from '../components/server-settings/BansPanel.js';
import { EmojiPanel } from '../components/server-settings/EmojiPanel.js';
import { FederationPanel } from '../components/server-settings/FederationPanel.js';
import { MembersPanel } from '../components/server-settings/MembersPanel.js';
import { RolesPanel } from '../components/server-settings/RolesPanel.js';
import { SafetyPolicyPanel } from '../components/server-settings/SafetyPolicyPanel.js';
import { ModerationHardeningPanel } from '../components/server-settings/ModerationHardeningPanel.js';
import { OnboardingPanel } from '../components/server-settings/OnboardingPanel.js';
import { TabButton } from '../components/server-settings/TabButton.js';

type Tab =
  | 'roles'
  | 'members'
  | 'invites'
  | 'bans'
  | 'emoji'
  | 'policy'
  | 'onboarding'
  | 'notifications'
  | 'integrations'
  | 'federation';

const ALL_TABS: Tab[] = [
  'roles',
  'members',
  'invites',
  'bans',
  'emoji',
  'policy',
  'onboarding',
  'notifications',
  'integrations',
  'federation',
];

function readInitialSettingsState(): { tab: Tab; autoBan: boolean } {
  if (typeof window === 'undefined') return { tab: 'roles', autoBan: false };
  const sp = new URLSearchParams(window.location.search);
  const tabParam = sp.get('tab');
  const tab = (ALL_TABS as string[]).includes(tabParam ?? '') ? (tabParam as Tab) : 'roles';
  const autoBan = tab === 'bans' && sp.get('action') === 'ban';
  return { tab, autoBan };
}

export function ServerSettingsPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const initial = readInitialSettingsState();
  const [tab, setTab] = useState<Tab>(initial.tab);

  if (!serverId) return <div className="p-12">Pick a tavern.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Settings size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Tavern settings</span>
        <div className="ml-auto flex gap-1 text-xs" role="tablist" aria-label="Tavern settings sections">
          <TabButton active={tab === 'roles'} onClick={() => setTab('roles')}>
            <Tag size={12} /> Roles
          </TabButton>
          <TabButton active={tab === 'members'} onClick={() => setTab('members')}>
            <Users size={12} /> Members
          </TabButton>
          <TabButton active={tab === 'invites'} onClick={() => setTab('invites')}>
            <DoorOpen size={12} /> Invites
          </TabButton>
          <TabButton active={tab === 'bans'} onClick={() => setTab('bans')}>
            <Ban size={12} /> Bans
          </TabButton>
          <TabButton active={tab === 'emoji'} onClick={() => setTab('emoji')}>
            <Smile size={12} /> Emoji
          </TabButton>
          <TabButton active={tab === 'policy'} onClick={() => setTab('policy')}>
            <ShieldCheck size={12} /> Safety policy
          </TabButton>
          <TabButton active={tab === 'onboarding'} onClick={() => setTab('onboarding')}>
            <HeartHandshake size={12} /> Onboarding
          </TabButton>
          <TabButton active={tab === 'notifications'} onClick={() => setTab('notifications')}>
            <Bell size={12} /> Notifications
          </TabButton>
          <TabButton active={tab === 'integrations'} onClick={() => setTab('integrations')}>
            <Bot size={12} /> Integrations
          </TabButton>
          <TabButton active={tab === 'federation'} onClick={() => setTab('federation')}>
            <Globe size={12} /> Federation
          </TabButton>
        </div>
      </header>
      <div className="p-6">
        {tab === 'roles' ? <RolesPanel serverId={serverId} /> : null}
        {tab === 'members' ? <MembersPanel serverId={serverId} /> : null}
        {tab === 'invites' ? <ServerInvitesPanel serverId={serverId} /> : null}
        {tab === 'bans' ? <BansPanel serverId={serverId} autoOpenBan={initial.autoBan} /> : null}
        {tab === 'emoji' ? <EmojiPanel serverId={serverId} /> : null}
        {tab === 'policy' ? (
          <div className="space-y-6">
            <SafetyPolicyPanel serverId={serverId} />
            <ModerationHardeningPanel serverId={serverId} />
          </div>
        ) : null}
        {tab === 'onboarding' ? <OnboardingPanel serverId={serverId} /> : null}
        {tab === 'notifications' ? <PerTavernNotificationSettings serverId={serverId} /> : null}
        {tab === 'integrations' ? <ServerIntegrationsPanel serverId={serverId} /> : null}
        {tab === 'federation' ? <FederationPanel serverId={serverId} /> : null}
      </div>
    </div>
  );
}
