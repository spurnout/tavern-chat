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
import { Tabs, TabList, Tab, TabPanel } from '../components/Tabs.js';

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
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} asChild>
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex flex-col gap-3 border-b border-subtle px-4 py-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <Settings size={16} className="text-fg-muted" />
            <span className="font-serif font-medium">Tavern settings</span>
          </div>
          <TabList
            className="w-full text-xs sm:ml-auto sm:w-auto"
            aria-label="Tavern settings sections"
          >
            <Tab value="roles">
              <Tag size={12} /> Roles
            </Tab>
            <Tab value="members">
              <Users size={12} /> Members
            </Tab>
            <Tab value="invites">
              <DoorOpen size={12} /> Invites
            </Tab>
            <Tab value="bans">
              <Ban size={12} /> Bans
            </Tab>
            <Tab value="emoji">
              <Smile size={12} /> Emoji
            </Tab>
            <Tab value="policy">
              <ShieldCheck size={12} /> Safety policy
            </Tab>
            <Tab value="onboarding">
              <HeartHandshake size={12} /> Onboarding
            </Tab>
            <Tab value="notifications">
              <Bell size={12} /> Notifications
            </Tab>
            <Tab value="integrations">
              <Bot size={12} /> Integrations
            </Tab>
            <Tab value="federation">
              <Globe size={12} /> Federation
            </Tab>
          </TabList>
        </header>
        <div className="p-6">
          <TabPanel value="roles">
            <RolesPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="members">
            <MembersPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="invites">
            <ServerInvitesPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="bans">
            <BansPanel serverId={serverId} autoOpenBan={initial.autoBan} />
          </TabPanel>
          <TabPanel value="emoji">
            <EmojiPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="policy">
            <div className="space-y-6">
              <SafetyPolicyPanel serverId={serverId} />
              <ModerationHardeningPanel serverId={serverId} />
            </div>
          </TabPanel>
          <TabPanel value="onboarding">
            <OnboardingPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="notifications">
            <PerTavernNotificationSettings serverId={serverId} />
          </TabPanel>
          <TabPanel value="integrations">
            <ServerIntegrationsPanel serverId={serverId} />
          </TabPanel>
          <TabPanel value="federation">
            <FederationPanel serverId={serverId} />
          </TabPanel>
        </div>
      </div>
    </Tabs>
  );
}
