export const PROTOCOL_VERSION = 'ir20/1' as const;
export const WELL_KNOWN_PATH = '/.well-known/tavern-federation' as const;

export const CAPABILITIES = [
  'messages',
  'dms',
  'presence',
  'invites',
  'moderation',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ENVELOPE_EVENT_TYPES = [
  'peering.request',
  'peering.accept',
  'peering.revoke',
  'profile.request',
  'profile.response',
  'message.create',
  'message.update',
  'message.delete',
  'reaction.add',
  'reaction.remove',
] as const;
export type EnvelopeEventType = (typeof ENVELOPE_EVENT_TYPES)[number];

// Replay-window defaults (seconds). Receivers tolerate +-CLOCK_SKEW.
export const ENVELOPE_DEFAULT_LIFETIME_S = 300; // 5 min
export const ENVELOPE_CLOCK_SKEW_S = 60;

// Locked design decisions (not runtime constants — documented here for reference):
//   protocolFamily:  'tavern-native'
//   identityFormat:  'user@host'
//   remoteUserRole:  '@federated'
//   dmDefault:       'opt-in-per-instance-and-user'
//   backfillWindow:  'none'
