import type { AuditLogAction } from '@tavern/shared';

export type AuditAccent = 'fg' | 'good' | 'warn' | 'danger' | 'mead' | 'lavender' | 'dusk';
export type AuditCategory =
  | 'moderation'
  | 'roles'
  | 'invites'
  | 'server'
  | 'campaigns'
  | 'other';

interface AuditActionMeta {
  accent: AuditAccent;
  category: AuditCategory;
  /** Sentence template — `{actor}` and `{target}` are filled in by the renderer. */
  template: string;
  /** When true, the renderer should look for `metadata.before` and `metadata.after`. */
  hasDiff?: boolean;
}

const TABLE: Record<AuditLogAction, AuditActionMeta> = {
  'server.created': { accent: 'good', category: 'server', template: '{actor} lit this tavern.' },
  'server.updated': {
    accent: 'fg',
    category: 'server',
    template: '{actor} updated the tavern settings.',
    hasDiff: true,
  },
  'channel.created': {
    accent: 'good',
    category: 'server',
    template: '{actor} created room {target}.',
  },
  'channel.updated': {
    accent: 'fg',
    category: 'server',
    template: '{actor} updated room {target}.',
    hasDiff: true,
  },
  'channel.deleted': {
    accent: 'danger',
    category: 'server',
    template: '{actor} removed room {target}.',
  },
  'role.created': { accent: 'good', category: 'roles', template: '{actor} created a role.' },
  'role.updated': {
    accent: 'fg',
    category: 'roles',
    template: '{actor} updated a role.',
    hasDiff: true,
  },
  'role.deleted': { accent: 'danger', category: 'roles', template: '{actor} removed a role.' },
  'role.assigned': {
    accent: 'mead',
    category: 'roles',
    template: '{actor} assigned a role to {target}.',
  },
  'role.revoked': {
    accent: 'warn',
    category: 'roles',
    template: '{actor} revoked a role from {target}.',
  },
  'member.joined': {
    accent: 'good',
    category: 'other',
    template: '{target} pulled up a chair.',
  },
  'member.left': { accent: 'fg', category: 'other', template: '{target} left the table.' },
  'member.kicked': {
    accent: 'warn',
    category: 'moderation',
    template: '{actor} asked {target} to step out.',
  },
  'member.banned': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} removed {target} from the tavern.',
  },
  'member.unbanned': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} welcomed {target} back.',
  },
  'member.timed_out': {
    accent: 'warn',
    category: 'moderation',
    template: '{actor} timed out {target}.',
  },
  'message.deleted': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} deleted a message.',
  },
  'message.held': {
    accent: 'warn',
    category: 'moderation',
    template: '{actor} held a message for review.',
  },
  'message.released': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} released a held message.',
  },
  'message.quarantined': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} quarantined a message.',
  },
  'attachment.blocked': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} blocked an attachment.',
  },
  'attachment.quarantined': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} quarantined an attachment.',
  },
  'attachment.released': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} released an attachment.',
  },
  'invite.created': {
    accent: 'good',
    category: 'invites',
    template: '{actor} created an invite.',
  },
  'invite.revoked': {
    accent: 'warn',
    category: 'invites',
    template: '{actor} revoked an invite.',
  },
  'report.created': {
    accent: 'warn',
    category: 'moderation',
    template: '{actor} filed a report.',
  },
  'report.resolved': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} resolved a report.',
  },
  'safety_policy.updated': {
    accent: 'mead',
    category: 'server',
    template: '{actor} updated the safety policy.',
    hasDiff: true,
  },
  'instance_safety_policy.updated': {
    accent: 'mead',
    category: 'server',
    template: '{actor} updated the instance safety policy.',
    hasDiff: true,
  },
  'campaign.created': {
    accent: 'lavender',
    category: 'campaigns',
    template: '{actor} started a campaign.',
  },
  'campaign.updated': {
    accent: 'lavender',
    category: 'campaigns',
    template: '{actor} updated a campaign.',
    hasDiff: true,
  },
  'campaign.archived': {
    accent: 'fg',
    category: 'campaigns',
    template: '{actor} archived a campaign.',
  },
  'session.created': {
    accent: 'mead',
    category: 'campaigns',
    template: '{actor} scheduled a session.',
  },
  'session.updated': {
    accent: 'mead',
    category: 'campaigns',
    template: '{actor} updated a session.',
    hasDiff: true,
  },
  'game_night.created': {
    accent: 'mead',
    category: 'campaigns',
    template: '{actor} scheduled a game night.',
  },
  'game_night.updated': {
    accent: 'mead',
    category: 'campaigns',
    template: '{actor} updated a game night.',
    hasDiff: true,
  },
  'user.posting_locked': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} locked {target} from posting.',
  },
  'user.posting_unlocked': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} restored posting for {target}.',
  },
  'user.uploads_locked': {
    accent: 'danger',
    category: 'moderation',
    template: '{actor} locked uploads for {target}.',
  },
  'user.uploads_unlocked': {
    accent: 'good',
    category: 'moderation',
    template: '{actor} restored uploads for {target}.',
  },
};

const FALLBACK: AuditActionMeta = {
  accent: 'fg',
  category: 'other',
  template: '{actor} did {action}.',
};

export function metaFor(action: string): AuditActionMeta {
  return (TABLE as Record<string, AuditActionMeta | undefined>)[action] ?? FALLBACK;
}

export const AUDIT_CATEGORIES: Array<{ id: AuditCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All actions' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'roles', label: 'Roles' },
  { id: 'invites', label: 'Invites' },
  { id: 'server', label: 'Server' },
  { id: 'campaigns', label: 'Campaigns' },
];
