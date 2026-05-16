import { useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface TokenRow {
  id: string;
  label: string;
  scopes: unknown;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface CreateResp {
  id: string;
  label: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
}

export function AccountTokensSection(): JSX.Element {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState('');
  const [latest, setLatest] = useState<CreateResp | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const r = await api<TokenRow[]>('/me/tokens');
      setRows(r.filter((t) => !t.revokedAt));
    } catch {
      // silent
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function mint(): Promise<void> {
    if (!label.trim()) {
      toast.error('Give the token a label so you can recognise it later.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<CreateResp>('/me/tokens', {
        method: 'POST',
        body: { label: label.trim() },
      });
      setLatest(r);
      setLabel('');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not mint token');
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/me/tokens/${id}`, { method: 'DELETE' });
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">API tokens</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Personal access tokens authenticate scripts, integrations, and CLIs as you. Treat them like
        passwords.
      </p>
      <div className="mt-3 space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is this token for?"
            className="input flex-1"
            maxLength={60}
          />
          <button type="button" className="btn-primary" onClick={() => void mint()} disabled={busy}>
            <Plus size={14} className="mr-1.5 inline-block" /> Mint token
          </button>
        </div>
        {latest ? (
          <div className="rounded border border-ember bg-tint-ember p-3">
            <p className="mb-2 font-medium">Copy this token now — you won’t see it again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
                {latest.token}
              </code>
              <button
                type="button"
                className="rounded p-1 hover:bg-raised"
                onClick={() => void navigator.clipboard.writeText(latest.token)}
                aria-label="Copy"
                title="Copy"
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
        ) : null}
        <ul className="space-y-1">
          {rows.length === 0 ? (
            <li className="text-fg-muted">No tokens yet.</li>
          ) : (
            rows.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded border border-subtle bg-canvas px-3 py-2"
              >
                <KeyRound size={12} className="text-fg-muted" />
                <span className="font-medium">{t.label}</span>
                <span className="ml-3 font-mono text-xs text-fg-muted">
                  created {new Date(t.createdAt).toLocaleDateString()}
                  {t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : ''}
                </span>
                <button
                  type="button"
                  className="ml-auto rounded p-1 text-fg-muted hover:bg-raised"
                  onClick={() => void revoke(t.id)}
                  aria-label="Revoke"
                  title="Revoke"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );
}
