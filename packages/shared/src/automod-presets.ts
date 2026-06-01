/**
 * Built-in AutoMod presets (parity gap #4).
 *
 * A preset is a curated bundle of AutomodRule rows. Enabling one seeds real
 * rows (tagged with `presetId`) through the existing automod engine — no
 * change to `evaluateAutomod`, and operators can edit / disable individual
 * rows afterwards via the normal automod CRUD.
 *
 * Deterministic and operator-driven (no AI). The wordlist/regex patterns are
 * a starting point and are meant to be tuned per community.
 */

export type AutomodPresetKind = 'regex' | 'wordlist' | 'link_rate' | 'message_rate';
export type AutomodPresetAction = 'log_only' | 'delete' | 'hold' | 'warn' | 'timeout';

export interface AutomodPresetRule {
  name: string;
  kind: AutomodPresetKind;
  pattern: string;
  action: AutomodPresetAction;
}

export interface AutomodPreset {
  id: string;
  label: string;
  description: string;
  rules: ReadonlyArray<AutomodPresetRule>;
}

export const AUTOMOD_PRESETS: ReadonlyArray<AutomodPreset> = [
  {
    id: 'invite-link-spam',
    label: 'Invite-link spam',
    description:
      'Deletes messages containing chat-invite links from common platforms — a frequent spam / raid vector.',
    rules: [
      {
        name: 'Chat invite links',
        kind: 'regex',
        // discord.gg / discord invites, telegram t.me, generic /invite/ paths.
        pattern: '(discord\\.(gg|com/invite)|t\\.me/|join\\.[a-z]+/|/invite/)\\S+',
        action: 'delete',
      },
    ],
  },
  {
    id: 'mass-mention',
    label: 'Mass mention',
    description: 'Times out members who pack many @-mentions into one message (ping spam).',
    rules: [
      {
        name: 'Five or more mentions',
        kind: 'regex',
        pattern: '(@\\S+[\\s,]*){5,}',
        action: 'timeout',
      },
    ],
  },
  {
    id: 'common-slurs',
    label: 'Slur filter',
    description:
      'Deletes messages matching a starter wordlist of slurs. Tune the list for your community after enabling.',
    rules: [
      {
        name: 'Slur wordlist',
        kind: 'wordlist',
        // Intentionally a minimal, non-exhaustive seed. Operators extend it.
        pattern: 'slur1,slur2,slur3',
        action: 'delete',
      },
    ],
  },
];

export function findAutomodPreset(id: string): AutomodPreset | undefined {
  return AUTOMOD_PRESETS.find((p) => p.id === id);
}
