import { useState } from 'react';
import type { ActionRow } from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { cn } from '../lib/cn.js';

const BUTTON_STYLES: Record<string, string> = {
  primary: 'bg-ember text-fg-on-accent hover:bg-ember-hi',
  secondary: 'border border-subtle hover:bg-raised',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
  danger: 'bg-danger text-white hover:opacity-90',
  link: 'border border-subtle hover:bg-raised',
};

/** Render a message's interactive component rows (parity gap #2). */
export function MessageComponents({
  messageId,
  rows,
}: {
  messageId: string;
  rows: ActionRow[];
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  if (rows.length === 0) return null;

  async function press(customId: string, values: string[]): Promise<void> {
    setBusy(true);
    try {
      const res = await api<{ content?: string }>(`/messages/${messageId}/interactions`, {
        method: 'POST',
        body: { customId, values },
      });
      if (res.content) toast.info(res.content);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not complete that action');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-1">
      {rows.map((row, ri) => (
        <div key={ri} className="flex flex-wrap items-center gap-1.5">
          {row.components.map((c, ci) => {
            if (c.type === 'button') {
              if (c.style === 'link') {
                return (
                  <a
                    key={ci}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn('rounded px-3 py-1 text-xs', BUTTON_STYLES.link)}
                  >
                    {c.label}
                  </a>
                );
              }
              return (
                <button
                  key={ci}
                  type="button"
                  disabled={busy || c.disabled}
                  onClick={() => void press(c.customId!, [])}
                  className={cn('rounded px-3 py-1 text-xs disabled:opacity-50', BUTTON_STYLES[c.style])}
                >
                  {c.label}
                </button>
              );
            }
            // Select menu.
            return (
              <select
                key={ci}
                disabled={busy}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void press(c.customId, [e.target.value]);
                }}
                className="rounded border border-subtle bg-canvas px-2 py-1 text-xs"
              >
                <option value="" disabled>
                  {c.placeholder ?? 'Choose…'}
                </option>
                {c.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            );
          })}
        </div>
      ))}
    </div>
  );
}
