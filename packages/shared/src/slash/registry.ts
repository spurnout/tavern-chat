import { z } from 'zod';
import type { PermissionFlag } from '../permissions.js';

/**
 * Slash command framework.
 *
 * The client parses a leading `/word ...` into a command + args, shows
 * autocomplete from the catalog, and either:
 *   - posts to `POST /api/channels/:id/slash` (server-handled), or
 *   - opens a client-side modal (when the catalog entry sets `clientAction`).
 *
 * The catalog itself is shared so the autocomplete UI doesn't need a round
 * trip on every keystroke. The server still enforces `requiredPermissions`
 * at execution time — autocomplete is a hint, not authorization.
 */

export interface SlashCatalogEntry {
  name: string;
  description: string;
  argsHint: string;
  requiredPermissions?: PermissionFlag[];
  /**
   * When set, the client opens this modal instead of POSTing to /slash.
   * The modal then calls its own dedicated endpoint (e.g. /polls).
   */
  clientAction?: 'open_poll_modal' | 'open_encounter_modal' | 'open_remind_modal';
}

export const SLASH_CATALOG: ReadonlyArray<SlashCatalogEntry> = [
  {
    name: 'roll',
    description: 'Roll dice in this room',
    argsHint: '1d20+5',
    requiredPermissions: ['ROLL_DICE'],
  },
  {
    name: 'me',
    description: 'Send an action message in third-person',
    argsHint: 'waves hello',
    requiredPermissions: ['SEND_MESSAGES'],
  },
  {
    name: 'shrug',
    description: 'Append ¯\\_(ツ)_/¯',
    argsHint: '[optional text]',
    requiredPermissions: ['SEND_MESSAGES'],
  },
  {
    name: 'tableflip',
    description: 'Flip the table',
    argsHint: '[optional text]',
    requiredPermissions: ['SEND_MESSAGES'],
  },
  {
    name: 'unflip',
    description: 'Put the table back',
    argsHint: '[optional text]',
    requiredPermissions: ['SEND_MESSAGES'],
  },
  {
    name: 'pin',
    description: 'Pin the message you’re replying to',
    argsHint: '',
    requiredPermissions: ['MANAGE_MESSAGES'],
  },
  {
    name: 'save',
    description: 'Bookmark the message you’re replying to',
    argsHint: '',
    requiredPermissions: ['SEND_MESSAGES'],
  },
  {
    name: 'poll',
    description: 'Start a poll',
    argsHint: 'question | option | option',
    requiredPermissions: ['SEND_MESSAGES'],
    clientAction: 'open_poll_modal',
  },
  {
    name: 'remind',
    description: 'Schedule a reminder to yourself',
    argsHint: 'in 1h feed the cat',
    requiredPermissions: ['SEND_MESSAGES'],
    clientAction: 'open_remind_modal',
  },
  {
    name: 'encounter',
    description: 'Start an initiative encounter',
    argsHint: '[name]',
    requiredPermissions: ['MANAGE_SESSIONS'],
    clientAction: 'open_encounter_modal',
  },
];

export const SLASH_COMMAND_NAMES = SLASH_CATALOG.map((e) => e.name);
export type SlashCommandName = (typeof SLASH_CATALOG)[number]['name'];

/** Parse a leading `/word ...rest` into { command, args } or null. */
export function parseSlashInput(text: string): { command: string; args: string } | null {
  if (!text.startsWith('/')) return null;
  const m = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const head = m[1];
  if (!head) return null;
  return { command: head.toLowerCase(), args: m[2]?.trim() ?? '' };
}

export function findSlashEntry(name: string): SlashCatalogEntry | undefined {
  return SLASH_CATALOG.find((e) => e.name === name.toLowerCase());
}

export const slashExecuteRequestSchema = z.object({
  command: z.string().min(1).max(64),
  args: z.string().max(2000).default(''),
  /** When set, the reply target — used by /pin and /save. */
  replyToMessageId: z.string().optional(),
  /** Idempotency key, same shape as message create. */
  nonce: z.string().min(1).max(64).optional(),
});

export type SlashExecuteRequest = z.infer<typeof slashExecuteRequestSchema>;

export const slashExecuteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), messageId: z.string() }),
  z.object({ kind: z.literal('roll'), diceRollId: z.string(), messageId: z.string().nullable() }),
  z.object({ kind: z.literal('pin'), messageId: z.string() }),
  z.object({ kind: z.literal('save'), messageId: z.string() }),
  z.object({ kind: z.literal('noop'), notice: z.string().optional() }),
]);

export type SlashExecuteResponse = z.infer<typeof slashExecuteResponseSchema>;

/** Catalog returned to clients — filtered by caller permissions on the server. */
export const slashCatalogResponseSchema = z.object({
  commands: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      argsHint: z.string(),
      clientAction: z.string().optional(),
    }),
  ),
});

export type SlashCatalogResponse = z.infer<typeof slashCatalogResponseSchema>;
