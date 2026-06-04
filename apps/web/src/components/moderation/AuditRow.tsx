import {
  Archive,
  CheckCircle2,
  CircleSlash,
  FileEdit,
  Flag,
  Hash,
  Mail,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import type { AuditLogEntry } from '@tavern/shared';
import { cn } from '../../lib/cn.js';
import { metaFor, type AuditAccent } from '../../lib/audit-actions.js';

const ACCENT_CLASS: Record<AuditAccent, string> = {
  fg: 'bg-raised text-fg-muted',
  good: 'bg-tint-moss text-moss',
  warn: 'bg-tint-mead text-mead',
  danger: 'bg-tint-rust text-rust',
  lavender: 'bg-tint-lavender text-lavender',
  dusk: 'bg-tint-dusk text-dusk',
};

function iconFor(action: string): JSX.Element {
  switch (action) {
    case 'server.created':
    case 'channel.created':
      return <Hash size={14} />;
    case 'channel.deleted':
    case 'role.deleted':
    case 'message.deleted':
      return <Trash2 size={14} />;
    case 'role.assigned':
    case 'role.revoked':
      return <Users size={14} />;
    case 'member.joined':
    case 'member.unbanned':
      return <UserPlus size={14} />;
    case 'member.left':
    case 'member.kicked':
      return <UserMinus size={14} />;
    case 'member.banned':
    case 'user.posting_locked':
    case 'user.uploads_locked':
      return <CircleSlash size={14} />;
    case 'member.timed_out':
    case 'message.held':
    case 'message.quarantined':
    case 'attachment.blocked':
    case 'attachment.quarantined':
      return <ShieldAlert size={14} />;
    case 'message.released':
    case 'attachment.released':
    case 'user.posting_unlocked':
    case 'user.uploads_unlocked':
      return <ShieldCheck size={14} />;
    case 'report.created':
      return <Flag size={14} />;
    case 'report.resolved':
      return <CheckCircle2 size={14} />;
    case 'invite.created':
    case 'invite.revoked':
      return <Mail size={14} />;
    case 'campaign.created':
    case 'campaign.updated':
    case 'session.created':
    case 'session.updated':
    case 'game_night.created':
    case 'game_night.updated':
      return <Sparkles size={14} />;
    case 'campaign.archived':
      return <Archive size={14} />;
    default:
      return <FileEdit size={14} />;
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

interface Props {
  entry: AuditLogEntry;
}

export function AuditRow({ entry }: Props): JSX.Element {
  const meta = metaFor(entry.action);
  const actorName = entry.actorDisplayName ?? '(system)';
  const targetLabel = entry.targetId
    ? `${entry.targetType ?? 'item'}:${entry.targetId.slice(0, 8)}`
    : 'an item';
  const sentence = meta.template
    .replace('{actor}', actorName)
    .replace('{target}', targetLabel)
    .replace('{action}', entry.action);

  const diff =
    meta.hasDiff && entry.metadata && typeof entry.metadata === 'object'
      ? renderDiff(entry.metadata as Record<string, unknown>)
      : null;

  return (
    <li className="flex gap-3 border-b border-subtle px-4 py-3 last:border-b-0">
      <div
        className={cn(
          'grid h-7 w-7 shrink-0 place-items-center rounded-full',
          ACCENT_CLASS[meta.accent],
        )}
        aria-hidden
      >
        {iconFor(entry.action)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-sm">
          {entry.actorDisplayName ? (
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-raised text-[10px] text-fg-muted"
              aria-hidden
              title={entry.actorUsername ? `@${entry.actorUsername}` : undefined}
            >
              {initials(entry.actorDisplayName)}
            </span>
          ) : null}
          <span className="text-fg">{sentence}</span>
        </div>
        {diff}
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
          {new Date(entry.createdAt).toLocaleString()}
        </div>
      </div>
    </li>
  );
}

function renderDiff(meta: Record<string, unknown>): JSX.Element | null {
  const before = meta.before;
  const after = meta.after;
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return null;
  const beforeRec = before as Record<string, unknown>;
  const afterRec = after as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(beforeRec), ...Object.keys(afterRec)]));
  const rows: JSX.Element[] = [];
  for (const k of keys) {
    const b = beforeRec[k];
    const a = afterRec[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    rows.push(
      <div key={`${k}-`} className="flex gap-2">
        <span className="font-mono text-rust">-</span>
        <span className="font-mono text-fg-muted">
          {k}: {format(b)}
        </span>
      </div>,
      <div key={`${k}+`} className="flex gap-2">
        <span className="font-mono text-moss">+</span>
        <span className="font-mono text-fg-muted">
          {k}: {format(a)}
        </span>
      </div>,
    );
  }
  if (rows.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 rounded border border-subtle bg-canvas p-2 text-[11px]">
      {rows}
    </div>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  return JSON.stringify(v);
}
