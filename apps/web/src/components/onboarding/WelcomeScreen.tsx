import { useEffect, useState } from 'react';
import type { ServerOnboarding } from '@tavern/shared';
import { Modal } from '../Modal.js';
import { api, ApiError } from '../../lib/api-client.js';
import { toast } from '../../lib/toast.js';

/**
 * First-run welcome screen shown to a member of a tavern with onboarding
 * enabled. Renders the welcome message, recommended rooms, rules acceptance,
 * and the self-assign role picker, then posts the member's choices.
 *
 * Whether it has been seen is tracked in localStorage per tavern so it doesn't
 * reappear after completion. The rules requirement is also enforced
 * server-side (the message-create posting gate), so dismissing the dialog
 * without accepting still can't bypass it.
 */
function seenKey(serverId: string): string {
  return `tavern.onboarded.${serverId}`;
}

export function WelcomeScreen({ serverId }: { serverId: string }): JSX.Element | null {
  const [data, setData] = useState<ServerOnboarding | null>(null);
  const [open, setOpen] = useState(false);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setOpen(false);
    setAcceptedRules(false);
    setSelections({});
    if (typeof window !== 'undefined' && window.localStorage.getItem(seenKey(serverId))) {
      return;
    }
    api<ServerOnboarding>(`/servers/${serverId}/onboarding`)
      .then((o) => {
        if (cancelled) return;
        setData(o);
        if (o.enabled) setOpen(true);
      })
      .catch(() => {
        /* no onboarding / not permitted — stay closed */
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  if (!data || !data.enabled) return null;

  const needsRules = data.requireRules && data.rulesMd.length > 0;
  const canSubmit = !needsRules || acceptedRules;

  function toggleOption(promptId: string, optionId: string, multi: boolean): void {
    setSelections((prev) => {
      const current = prev[promptId] ?? [];
      if (multi) {
        return current.includes(optionId)
          ? { ...prev, [promptId]: current.filter((x) => x !== optionId) }
          : { ...prev, [promptId]: [...current, optionId] };
      }
      return { ...prev, [promptId]: current.includes(optionId) ? [] : [optionId] };
    });
  }

  function dismiss(): void {
    if (typeof window !== 'undefined') window.localStorage.setItem(seenKey(serverId), '1');
    setOpen(false);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      await api(`/servers/${serverId}/onboarding/complete`, {
        method: 'POST',
        body: { acceptedRules, selections },
      });
      dismiss();
      toast.success('Welcome — pull up a chair');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not finish onboarding');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
      title="Welcome to the tavern"
      widthClass="w-[min(94vw,560px)]"
      footer={
        <>
          <button
            type="button"
            className="rounded border border-subtle px-3 py-1.5 text-sm text-fg hover:bg-raised"
            onClick={dismiss}
          >
            Maybe later
          </button>
          <button
            type="button"
            disabled={!canSubmit || busy}
            className="rounded bg-ember px-3 py-1.5 text-sm text-fg-on-accent hover:bg-ember-hi disabled:opacity-50"
            onClick={() => void submit()}
          >
            Pull up a chair
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {data.welcomeText ? (
          <p className="whitespace-pre-wrap text-sm text-fg">{data.welcomeText}</p>
        ) : null}

        {data.recommendedRooms.length > 0 ? (
          <section>
            <h3 className="text-xs uppercase tracking-wider text-fg-muted">Rooms to start in</h3>
            <ul className="mt-1 space-y-1">
              {data.recommendedRooms.map((r) => (
                <li key={r.channelId} className="text-sm">
                  <span className="font-medium">#{r.channelId}</span>
                  {r.description ? <span className="text-fg-muted"> — {r.description}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data.prompts.map((p) => (
          <section key={p.id}>
            <h3 className="text-sm font-medium">{p.title}</h3>
            <div className="mt-1 flex flex-wrap gap-2">
              {p.options.map((o) => {
                const picked = (selections[p.id] ?? []).includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggleOption(p.id, o.id, p.multiSelect)}
                    className={
                      picked
                        ? 'rounded-full border border-ember bg-tint-ember px-3 py-1 text-xs text-mead'
                        : 'rounded-full border border-subtle px-3 py-1 text-xs hover:bg-raised'
                    }
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {needsRules ? (
          <section className="rounded border border-subtle bg-sunken p-3">
            <h3 className="text-xs uppercase tracking-wider text-fg-muted">House rules</h3>
            <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-fg">
              {data.rulesMd}
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={acceptedRules}
                onChange={(e) => setAcceptedRules(e.target.checked)}
              />
              I’ve read and accept the rules
            </label>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
