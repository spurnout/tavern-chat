import { useState } from 'react';
import type { ModerationAction, Report } from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';
import { cn } from '../../lib/cn.js';

interface Props {
  report: Report;
  /** Triggered after a successful resolve/escalate so the parent can refresh. */
  onResolved: () => void;
  /** Opens the ban modal for `targetUserDisplayName` / `targetUserId`. */
  onEscalateBan?: (userId: string, displayName: string | null) => void;
}

const CATEGORY_LABEL: Partial<Record<Report['category'], string>> = {
  suspected_child_exploitation_or_csam: 'CSAM',
  non_consensual_intimate_material: 'Non-consensual intimate material',
  credible_threat_or_violent_coordination: 'Credible threat',
  stalking_swatting_or_targeted_harassment: 'Targeted harassment',
  doxxing_or_private_information: 'Doxxing / private info',
  malware_phishing_or_credential_theft: 'Malware / phishing',
  illegal_marketplace_or_trafficking: 'Illegal marketplace',
  fraud_or_scam: 'Fraud / scam',
  spam_or_raid: 'Spam / raid',
  policy_evasion: 'Policy evasion',
  other_serious_abuse: 'Other serious abuse',
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
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

export function ReportCard({ report, onResolved, onEscalateBan }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function resolve(
    status: 'resolved' | 'dismissed' | 'escalated',
    action?: ModerationAction,
  ): Promise<void> {
    setBusy(true);
    try {
      await api(`/reports/${report.id}/resolve`, {
        method: 'POST',
        body: { status, action },
      });
      toast.success(
        status === 'dismissed' ? 'Dismissed.' : status === 'escalated' ? 'Escalated.' : 'Resolved.',
      );
      onResolved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not act on this report.');
    } finally {
      setBusy(false);
    }
  }

  const reporterName = report.reporterDisplayName ?? 'A member';
  const targetName = report.targetUserDisplayName ?? null;
  const category = CATEGORY_LABEL[report.category] ?? report.category.replace(/_/g, ' ');
  const statusPill =
    report.status === 'in_review'
      ? { label: 'In review', cls: 'bg-tint-mead text-mead' }
      : { label: 'Open', cls: 'bg-tint-rust text-rust' };

  return (
    <article className="rounded-lg border border-subtle bg-surface p-4">
      <div className="flex items-start gap-3">
        <div
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised font-serif text-sm"
          aria-hidden
        >
          {targetName ? initials(targetName) : '?'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-serif text-base text-fg">
              {targetName ?? 'Unknown target'}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
                statusPill.cls,
              )}
            >
              {statusPill.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              {timeAgo(report.createdAt)} · {report.targetType}
            </span>
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            <span className="text-fg">{reporterName}</span> reported{' '}
            <span className="text-fg-muted">{category}</span>
            {report.notes ? <> — “{report.notes}”</> : null}
          </p>

          {report.targetPreview ? (
            <div className="mt-3 rounded border border-subtle bg-canvas p-3 text-sm">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
                {report.targetUserDisplayName ?? 'Reported content'} · {report.targetType}
              </div>
              <div className="whitespace-pre-wrap break-words text-fg">{report.targetPreview}</div>
            </div>
          ) : null}

          {report.events && report.events.length > 0 ? (
            <ul className="mt-3 space-y-1 border-l border-subtle pl-3">
              {report.events.map((e, i) => (
                <li key={i} className="text-xs text-fg-muted">
                  <span className="font-mono text-fg">{timeAgo(e.at)}</span> · {e.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={busy}
              onClick={() => void resolve('resolved', 'warn_user')}
            >
              Warn
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={busy}
              onClick={() => void resolve('resolved', 'block')}
            >
              Block content
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => void resolve('resolved', 'quarantine')}
            >
              Quarantine
            </button>
            {report.targetUserId && onEscalateBan ? (
              <button
                type="button"
                className="btn-danger text-xs"
                disabled={busy}
                onClick={() => onEscalateBan(report.targetUserId!, report.targetUserDisplayName ?? null)}
              >
                Remove member…
              </button>
            ) : null}
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={busy}
              onClick={() => void resolve('dismissed')}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
