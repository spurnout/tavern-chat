import { useEffect, useMemo, useState } from 'react';
import { Bot, Copy, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useRealtime } from '../lib/store.js';

interface BotResp {
  bot: { id: string; username: string; displayName: string };
  token: string;
}

interface WebhookRow {
  id: string;
  channelId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  lastDeliveryAt: string | null;
}

interface WebhookCreated extends WebhookRow {
  secret: string;
}

interface Props {
  serverId: string;
}

export function ServerIntegrationsPanel({ serverId }: Props): JSX.Element {
  return (
    <div className="space-y-6">
      <BotsSection serverId={serverId} />
      <WebhooksSection serverId={serverId} />
    </div>
  );
}

function BotsSection({ serverId }: { serverId: string }): JSX.Element {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [last, setLast] = useState<BotResp | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    if (!username.trim() || !displayName.trim()) return;
    setBusy(true);
    try {
      const r = await api<BotResp>(`/servers/${serverId}/bots`, {
        method: 'POST',
        body: { username: username.trim(), displayName: displayName.trim() },
      });
      setLast(r);
      setUsername('');
      setDisplayName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create bot');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-4">
      <h2 className="font-serif text-lg">Bots</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Bot accounts authenticate via API tokens. They show up as regular members in the tavern.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="block">
          <span className="text-xs text-fg-muted">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="input mt-1 w-40"
            maxLength={32}
            placeholder="trivia-bot"
          />
        </label>
        <label className="block">
          <span className="text-xs text-fg-muted">Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="input mt-1 w-40"
            maxLength={40}
            placeholder="Trivia Bot"
          />
        </label>
        <button type="button" className="btn-primary" onClick={() => void create()} disabled={busy}>
          <Bot size={14} className="mr-1.5 inline-block" /> Create bot
        </button>
      </div>
      {last ? (
        <div className="mt-3 rounded border border-ember bg-tint-ember p-3 text-sm">
          <p className="mb-2 font-medium">
            Bot @{last.bot.username} created. Copy this token now — you won’t see it again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
              {last.token}
            </code>
            <button
              type="button"
              className="rounded p-1 hover:bg-raised"
              onClick={() => void navigator.clipboard.writeText(last.token)}
              aria-label="Copy"
              title="Copy"
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WebhooksSection({ serverId }: { serverId: string }): JSX.Element {
  const channels = useRealtime((s) => s.channelsByServer[serverId] ?? []);
  const textChannels = useMemo(
    () => channels.filter((c) => c.type === 'text'),
    [channels],
  );
  const [selected, setSelected] = useState<string>(textChannels[0]?.id ?? '');
  const [rows, setRows] = useState<WebhookRow[]>([]);
  const [name, setName] = useState('');
  const [latest, setLatest] = useState<WebhookCreated | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!selected && textChannels[0]) setSelected(textChannels[0].id);
  }, [textChannels, selected]);

  async function refresh(): Promise<void> {
    if (!selected) return;
    try {
      const r = await api<WebhookRow[]>(`/channels/${selected}/webhooks`);
      setRows(r);
    } catch {
      setRows([]);
    }
  }
  useEffect(() => {
    void refresh();
  }, [selected]);

  async function create(): Promise<void> {
    if (!selected || !name.trim()) return;
    setBusy(true);
    try {
      const r = await api<WebhookCreated>(`/channels/${selected}/webhooks`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      setLatest(r);
      setName('');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create webhook');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api(`/webhooks/${id}`, { method: 'DELETE' });
      setRows((s) => s.filter((r) => r.id !== id));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not revoke');
    }
  }

  const webhookUrl = latest
    ? `${window.location.origin}/api/webhooks/${latest.id}/messages?token=${latest.secret}`
    : null;

  return (
    <section className="rounded border border-subtle bg-surface p-4">
      <h2 className="font-serif text-lg">Webhooks</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Each webhook posts messages into a specific room. Treat the URL as a secret.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="block">
          <span className="text-xs text-fg-muted">Room</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="input mt-1"
          >
            {textChannels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-fg-muted">Webhook name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input mt-1 w-40"
            maxLength={60}
            placeholder="release-bot"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void create()}
          disabled={busy || !selected}
        >
          <Plus size={14} className="mr-1.5 inline-block" /> Create webhook
        </button>
      </div>
      {latest && webhookUrl ? (
        <div className="mt-3 rounded border border-ember bg-tint-ember p-3 text-sm">
          <p className="mb-2 font-medium">
            Webhook URL — copy it now. You can re-mint if you lose it.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
              {webhookUrl}
            </code>
            <button
              type="button"
              className="rounded p-1 hover:bg-raised"
              onClick={() => void navigator.clipboard.writeText(webhookUrl)}
              aria-label="Copy"
              title="Copy"
            >
              <Copy size={14} />
            </button>
          </div>
        </div>
      ) : null}
      <ul className="mt-3 space-y-1 text-sm">
        {rows.length === 0 ? (
          <li className="text-fg-muted">No webhooks in this room.</li>
        ) : (
          rows.map((w) => (
            <li
              key={w.id}
              className="flex items-center gap-2 rounded border border-subtle bg-canvas px-3 py-2"
            >
              <WebhookIcon size={12} className="text-fg-muted" />
              <span className="font-medium">{w.name}</span>
              <span className="ml-3 font-mono text-xs text-fg-muted">
                created {new Date(w.createdAt).toLocaleDateString()}
                {w.lastDeliveryAt
                  ? ` · last fired ${new Date(w.lastDeliveryAt).toLocaleString()}`
                  : ' · never fired'}
              </span>
              <button
                type="button"
                className="ml-auto rounded p-1 text-fg-muted hover:bg-raised"
                onClick={() => void remove(w.id)}
                aria-label="Revoke"
                title="Revoke"
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
