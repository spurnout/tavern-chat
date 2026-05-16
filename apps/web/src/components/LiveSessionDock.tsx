import { useEffect, useState } from 'react';
import { Sparkles, BookOpen, ShieldAlert } from 'lucide-react';
import type { LiveSessionPayload } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { cn } from '../lib/cn.js';

interface Props {
  channelId: string;
}

interface Beat {
  label: string;
  active: boolean;
}

/**
 * Parse `CampaignSession.agenda` into a beats list. Each non-empty line is a
 * beat; a `*` or `>` prefix marks the active beat. Falls back to "no beats"
 * when the agenda is blank. This is a stopgap until a dedicated SceneBeat
 * model lands — when it does, only this parser needs to change.
 */
function parseBeats(agenda: string | null): Beat[] {
  if (!agenda) return [];
  const out: Beat[] = [];
  for (const raw of agenda.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('*') || line.startsWith('>')) {
      out.push({ label: line.replace(/^[*>]\s*/, ''), active: true });
    } else if (line.startsWith('- ')) {
      out.push({ label: line.slice(2), active: false });
    } else {
      out.push({ label: line, active: false });
    }
  }
  return out;
}

function elapsedSince(iso: string | null): string | null {
  if (!iso) return null;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m elapsed`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m elapsed`;
}

/**
 * Mounts above the channel's encounter/message stack. When a CampaignSession
 * tied to this channel is `status: 'live'`, surfaces the session's scene +
 * beats and (for GMs) up to 3 private campaign notes. Renders `null` when no
 * live session is active for the channel.
 */
export function LiveSessionDock({ channelId }: Props): JSX.Element | null {
  const [payload, setPayload] = useState<LiveSessionPayload | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api<LiveSessionPayload | null>(`/channels/${channelId}/live-session`)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 / 403 just mean no dock — never block the channel page.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setPayload(null);
        }
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  if (!loaded || !payload) return null;

  const { session, gmNotes, isGm } = payload;
  const beats = parseBeats(session.agenda);
  const activeIdx = beats.findIndex((b) => b.active);
  const sceneEyebrowParts: string[] = ['Live table'];
  if (beats.length > 0) {
    const i = activeIdx >= 0 ? activeIdx + 1 : 1;
    sceneEyebrowParts.push(`scene ${i} of ${beats.length}`);
  }
  const elapsed = elapsedSince(session.scheduledStart);
  if (elapsed) sceneEyebrowParts.push(elapsed);

  return (
    <section
      className="mx-4 mt-3 overflow-hidden rounded-lg border border-subtle bg-surface"
      style={{
        background:
          'linear-gradient(180deg, color-mix(in oklch, var(--mead) 7%, var(--bg-surface)), var(--bg-surface))',
        borderColor: 'color-mix(in oklch, var(--mead) 24%, var(--border-subtle))',
      }}
      aria-label="Live session dock"
    >
      <div className={cn('grid gap-0', isGm && gmNotes.length > 0 ? 'md:grid-cols-2' : '')}>
        <div className="border-b border-subtle p-4 md:border-b-0 md:border-r">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-mead">
            <Sparkles size={10} />
            {sceneEyebrowParts.join(' · ')}
          </div>
          <h3 className="mt-1 font-serif text-base text-fg">{session.title}</h3>
          {session.description ? (
            <p className="mt-1 text-xs text-fg-muted">{session.description}</p>
          ) : null}
          {beats.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {beats.map((b, i) => (
                <span
                  key={i}
                  className={cn(
                    'rounded border px-2 py-1 text-xs',
                    b.active
                      ? 'border-mead bg-tint-mead text-fg'
                      : 'border-subtle bg-canvas text-fg-muted',
                  )}
                >
                  {b.label}
                </span>
              ))}
            </div>
          ) : isGm ? (
            <p className="mt-3 text-xs text-fg-faint">
              No beats yet. Add them to the session agenda — one per line, prefix the active beat
              with <code className="font-mono">*</code>.
            </p>
          ) : null}
        </div>

        {isGm && gmNotes.length > 0 ? (
          <div className="p-4">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-mead">
              <BookOpen size={10} />
              GM notes
            </div>
            <ul className="mt-2 space-y-2">
              {gmNotes.map((n) => (
                <li key={n.id} className="rounded border border-subtle bg-canvas p-2 text-xs">
                  <div className="font-serif font-medium text-fg">
                    {n.pinned ? '📌 ' : ''}
                    {n.title}
                  </div>
                  {n.body ? (
                    <p className="mt-1 line-clamp-3 text-fg-muted">{n.body}</p>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-fg-faint">
              <ShieldAlert size={10} /> GM-only · not visible to players
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
