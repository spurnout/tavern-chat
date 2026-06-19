import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { Tabs, TabList, Tab, TabPanel } from './Tabs.js';

// Exercises the shared Tabs primitive that every settings/moderation/campaign
// strip now uses. The point of the Radix migration was the full WAI-ARIA tabs
// pattern, so we assert the two things the bespoke buttons lacked: tab↔tabpanel
// association (ids + aria-controls/aria-labelledby) and roving arrow-key focus.
function SettingsTabs(): JSX.Element {
  const [tab, setTab] = useState('roles');
  return (
    <Tabs value={tab} onValueChange={setTab} asChild>
      <div>
        <TabList aria-label="Settings sections">
          <Tab value="roles">Roles</Tab>
          <Tab value="members">Members</Tab>
          <Tab value="bans">Bans</Tab>
        </TabList>
        <TabPanel value="roles">Roles panel</TabPanel>
        <TabPanel value="members">Members panel</TabPanel>
        <TabPanel value="bans">Bans panel</TabPanel>
      </div>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('wires each tab to its panel and mounts only the active panel', () => {
    render(<SettingsTabs />);

    expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);

    const rolesTab = screen.getByRole('tab', { name: 'Roles' });
    expect(rolesTab).toHaveAttribute('aria-selected', 'true');

    // Inactive panels are not in the DOM, so there's exactly one tabpanel and
    // it is the one the selected tab controls.
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Roles panel');
    expect(rolesTab).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', rolesTab.id);
    // The labelledby reference resolves to the tab's text.
    expect(panel).toHaveAccessibleName('Roles');
  });

  it('moves selection with Arrow/Home/End keys (roving focus)', async () => {
    const user = userEvent.setup();
    render(<SettingsTabs />);

    // Tab into the strip — the active tab is the strip's single tab stop.
    const rolesTab = screen.getByRole('tab', { name: 'Roles' });
    await user.tab();
    expect(rolesTab).toHaveFocus();

    // ArrowRight → next tab gains focus and (automatic activation) selection.
    await user.keyboard('{ArrowRight}');
    const membersTab = screen.getByRole('tab', { name: 'Members' });
    expect(membersTab).toHaveFocus();
    expect(membersTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Members panel');

    // ArrowLeft → back to the first tab.
    await user.keyboard('{ArrowLeft}');
    expect(rolesTab).toHaveFocus();
    expect(rolesTab).toHaveAttribute('aria-selected', 'true');

    // End / Home → last / first tab.
    await user.keyboard('{End}');
    const bansTab = screen.getByRole('tab', { name: 'Bans' });
    expect(bansTab).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Bans panel');

    await user.keyboard('{Home}');
    expect(rolesTab).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Roles panel');
  });

  it('has no axe violations', async () => {
    const { container } = render(<SettingsTabs />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
