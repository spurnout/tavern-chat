import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Ban, Settings, ShieldCheck, Smile, Tag, Users } from 'lucide-react';
import type {
  CustomEmoji,
  Member,
  Role,
  SafetyPolicy,
  ServerBan,
  UpdateSafetyPolicyRequest,
} from '@tavern/shared';
import {
  Permission,
  combine,
  parsePermissions,
  serializePermissions,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { uploadFile } from '../lib/uploads.js';
import { awaitTerminal } from '../lib/attachment-ready.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';

type Tab = 'roles' | 'members' | 'bans' | 'emoji' | 'policy';

export function ServerSettingsPage(): JSX.Element {
  const { serverId } = useParams({ strict: false }) as { serverId?: string };
  const [tab, setTab] = useState<Tab>('roles');

  if (!serverId) return <div className="p-12">Pick a den.</div>;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Settings size={16} className="text-fg-muted" />
        <span className="font-serif font-medium">Den settings</span>
        <div className="ml-auto flex gap-1 text-xs">
          <TabButton active={tab === 'roles'} onClick={() => setTab('roles')}>
            <Tag size={12} /> Roles
          </TabButton>
          <TabButton active={tab === 'members'} onClick={() => setTab('members')}>
            <Users size={12} /> Members
          </TabButton>
          <TabButton active={tab === 'bans'} onClick={() => setTab('bans')}>
            <Ban size={12} /> Bans
          </TabButton>
          <TabButton active={tab === 'emoji'} onClick={() => setTab('emoji')}>
            <Smile size={12} /> Emoji
          </TabButton>
          <TabButton active={tab === 'policy'} onClick={() => setTab('policy')}>
            <ShieldCheck size={12} /> Safety policy
          </TabButton>
        </div>
      </header>
      <div className="p-6">
        {tab === 'roles' ? <RolesPanel serverId={serverId} /> : null}
        {tab === 'members' ? <MembersPanel serverId={serverId} /> : null}
        {tab === 'bans' ? <BansPanel serverId={serverId} /> : null}
        {tab === 'emoji' ? <EmojiPanel serverId={serverId} /> : null}
        {tab === 'policy' ? <SafetyPolicyPanel serverId={serverId} /> : null}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 ${
        active ? 'bg-raised text-fg' : 'text-fg-muted hover:bg-raised'
      }`}
    >
      {children}
    </button>
  );
}

// ---- Roles ----------------------------------------------------------------

const ROLE_FLAGS: Array<{ flag: bigint; label: string }> = [
  { flag: Permission.VIEW_CHANNEL, label: 'View rooms' },
  { flag: Permission.SEND_MESSAGES, label: 'Send messages' },
  { flag: Permission.READ_MESSAGE_HISTORY, label: 'Read history' },
  { flag: Permission.ATTACH_FILES, label: 'Attach files' },
  { flag: Permission.ADD_REACTIONS, label: 'Add reactions' },
  { flag: Permission.MENTION_EVERYONE, label: 'Mention everyone' },
  { flag: Permission.MANAGE_MESSAGES, label: 'Manage messages' },
  { flag: Permission.SEND_VOICE_MESSAGES, label: 'Send voice messages' },
  { flag: Permission.MANAGE_CHANNELS, label: 'Manage rooms' },
  { flag: Permission.MANAGE_ROLES, label: 'Manage roles' },
  { flag: Permission.MANAGE_SERVER, label: 'Manage den' },
  { flag: Permission.CREATE_INVITES, label: 'Create invites' },
  { flag: Permission.MANAGE_EMOJIS, label: 'Manage emojis' },
  { flag: Permission.KICK_MEMBERS, label: 'Kick members' },
  { flag: Permission.BAN_MEMBERS, label: 'Ban members' },
  { flag: Permission.TIMEOUT_MEMBERS, label: 'Timeout members' },
  { flag: Permission.VIEW_AUDIT_LOG, label: 'View audit log' },
  { flag: Permission.CONNECT_VOICE, label: 'Connect to voice' },
  { flag: Permission.SPEAK_VOICE, label: 'Speak in voice' },
  { flag: Permission.ENABLE_CAMERA, label: 'Enable camera' },
  { flag: Permission.STREAM_SCREEN, label: 'Stream screen' },
  { flag: Permission.MUTE_MEMBERS, label: 'Mute members' },
  { flag: Permission.DEAFEN_MEMBERS, label: 'Deafen members' },
  { flag: Permission.CREATE_CAMPAIGNS, label: 'Create campaigns' },
  { flag: Permission.MANAGE_CAMPAIGNS, label: 'Manage campaigns' },
  { flag: Permission.VIEW_GM_NOTES, label: 'View GM notes' },
  { flag: Permission.MANAGE_HANDOUTS, label: 'Manage handouts' },
  { flag: Permission.ROLL_DICE, label: 'Roll dice' },
  { flag: Permission.ROLL_PRIVATE_DICE, label: 'Roll private/GM dice' },
  { flag: Permission.MANAGE_BOARD_GAMES, label: 'Manage board games' },
  { flag: Permission.CREATE_GAME_NIGHTS, label: 'Create game nights' },
  { flag: Permission.MANAGE_GAME_NIGHTS, label: 'Manage game nights' },
  { flag: Permission.REPORT_CONTENT, label: 'Report content' },
  { flag: Permission.VIEW_MODERATION_QUEUE, label: 'View moderation queue' },
  { flag: Permission.MANAGE_REPORT_WORKFLOW, label: 'Manage reports' },
  { flag: Permission.MANAGE_QUARANTINE, label: 'Manage quarantine' },
  { flag: Permission.MANAGE_SERVER_SAFETY_POLICY, label: 'Manage safety policy' },
  { flag: Permission.ADMINISTRATOR, label: 'Administrator (bypasses everything)' },
];

function RolesPanel({ serverId }: { serverId: string }): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Role | null>(null);

  async function refresh(): Promise<void> {
    try {
      const r = await api<Role[]>(`/servers/${serverId}/roles`);
      setRoles(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load roles');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function createRole(): Promise<void> {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api<Role>(`/servers/${serverId}/roles`, {
        method: 'POST',
        body: { name: newName.trim(), permissions: '0' },
      });
      setNewName('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create');
    } finally {
      setBusy(false);
    }
  }

  async function saveRole(role: Role, perms: bigint): Promise<void> {
    setBusy(true);
    try {
      await api(`/roles/${role.id}`, {
        method: 'PATCH',
        body: { permissions: serializePermissions(perms) },
      });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole(role: Role): Promise<void> {
    if (!confirm(`Delete role "${role.name}"?`)) return;
    setBusy(true);
    try {
      await api(`/roles/${role.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <label className="flex-1 text-sm">
          <span className="mb-1 inline-block text-fg-muted">New role name</span>
          <input
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
            maxLength={64}
          />
        </label>
        <button
          className="btn-primary"
          onClick={() => void createRole()}
          disabled={busy || !newName.trim()}
        >
          Create role
        </button>
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {roles.map((r) => (
          <li key={r.id} className="card space-y-2">
            <div className="flex items-center gap-3">
              <div
                className="h-4 w-4 rounded-full"
                style={{ background: `#${r.color.toString(16).padStart(6, '0')}` }}
              />
              <span className="font-serif font-medium">{r.name}</span>
              {r.isEveryone ? (
                <span className="text-xs uppercase tracking-wider text-mead">default</span>
              ) : null}
              <span className="ml-auto text-xs text-fg-muted">
                {countPerms(parsePermissions(r.permissions))} permissions
              </span>
              <button
                className="btn-ghost text-xs"
                onClick={() => setEditing((e) => (e?.id === r.id ? null : r))}
              >
                {editing?.id === r.id ? 'Close' : 'Edit'}
              </button>
              {!r.isEveryone ? (
                <button
                  className="btn-ghost text-xs text-danger"
                  onClick={() => void deleteRole(r)}
                  disabled={busy}
                >
                  Delete
                </button>
              ) : null}
            </div>
            {editing?.id === r.id ? (
              <RoleEditor role={r} onSave={(p) => void saveRole(r, p)} disabled={busy} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function countPerms(p: bigint): number {
  let n = 0;
  for (let i = 0n; i < 64n; i++) {
    if ((p & (1n << i)) !== 0n) n++;
  }
  return n;
}

function RoleEditor({
  role,
  onSave,
  disabled,
}: {
  role: Role;
  onSave: (p: bigint) => void;
  disabled: boolean;
}): JSX.Element {
  const [perms, setPerms] = useState<bigint>(parsePermissions(role.permissions));

  function toggle(flag: bigint): void {
    setPerms((p) => ((p & flag) === flag ? p & ~flag : combine(p, flag)));
  }

  return (
    <div className="space-y-2 border-t border-subtle pt-3">
      <div className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {ROLE_FLAGS.map(({ flag, label }) => (
          <label
            key={String(flag)}
            className="flex items-center gap-2 rounded px-2 py-1 hover:bg-raised"
          >
            <input
              type="checkbox"
              checked={(perms & flag) === flag}
              onChange={() => toggle(flag)}
              disabled={disabled}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button className="btn-primary text-sm" onClick={() => onSave(perms)} disabled={disabled}>
          Save permissions
        </button>
      </div>
    </div>
  );
}

// ---- Members --------------------------------------------------------------

function MembersPanel({ serverId }: { serverId: string }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [m, r] = await Promise.all([
        api<Member[]>(`/servers/${serverId}/members`),
        api<Role[]>(`/servers/${serverId}/roles`),
      ]);
      setMembers(m);
      setRoles(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load members');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function setMemberRoles(userId: string, roleIds: string[]): Promise<void> {
    try {
      await api(`/servers/${serverId}/members/${userId}/roles`, {
        method: 'PUT',
        body: { roleIds },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update roles');
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <ul className="space-y-2">
        {members.map((m) => (
          <li key={m.userId} className="card flex flex-wrap items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised font-serif text-sm font-semibold">
              {m.userId.slice(-2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-serif font-medium">{m.nickname ?? m.userId.slice(0, 8)}</div>
              <div className="text-xs text-fg-muted">
                joined{' '}
                <time className="font-mono">
                  {new Date(m.joinedAt).toLocaleDateString()}
                </time>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {roles
                .filter((r) => !r.isEveryone)
                .map((r) => {
                  const has = m.roles.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        has
                          ? 'border-ember bg-tint-ember text-mead'
                          : 'border-subtle text-fg-muted hover:bg-raised'
                      }`}
                      onClick={() => {
                        const next = has
                          ? m.roles.filter((id) => id !== r.id)
                          : [...m.roles, r.id];
                        void setMemberRoles(m.userId, next);
                      }}
                    >
                      {r.name}
                    </button>
                  );
                })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Custom emoji ---------------------------------------------------------

function EmojiPanel({ serverId }: { serverId: string }): JSX.Element {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const e = await api<CustomEmoji[]>(`/servers/${serverId}/emojis`);
      setEmojis(e);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load emoji');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const name = prompt('Name (letters, digits, underscore):', file.name.replace(/\..*$/, ''));
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const att = await uploadFile({ file, serverId, kind: 'image' });
      // FE-17: wait for the worker's ATTACHMENT_READY gateway event instead
      // of a fixed 800ms poll. The bus auto-resolves a short retry-poll
      // fallback if the gateway isn't connected (e.g. cold-start, dev with
      // no Redis), so a brief network blip doesn't strand the upload.
      const status = att.status === 'ready' ? 'ready' : await awaitTerminal(att.id, 15_000).catch(() => 'pending');
      if (status !== 'ready') {
        throw new Error(
          status === 'pending'
            ? 'Worker is still processing the upload — try again in a moment.'
            : `Attachment ${status} during processing.`,
        );
      }
      await api(`/servers/${serverId}/emojis`, {
        method: 'POST',
        body: { name, attachmentId: att.id },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Delete emoji?')) return;
    try {
      await api(`/emojis/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  }

  return (
    <div className="space-y-4">
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="file"
          accept="image/png,image/gif,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => void onUpload(e)}
          disabled={busy}
        />
        <span className="btn-primary">{busy ? 'Uploading…' : 'Upload custom emoji'}</span>
      </label>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <p className="text-xs text-fg-muted">
        After upload, the worker scans &amp; processes the image. It may take a few seconds before
        the emoji shows below.
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {emojis.map((e) => (
          <li key={e.id} className="card flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded bg-raised text-lg">🖼</div>
            <div className="min-w-0 flex-1 truncate text-sm">:{e.name}:</div>
            <button
              className="text-xs text-danger hover:underline"
              onClick={() => void remove(e.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Safety policy --------------------------------------------------------

function SafetyPolicyPanel({ serverId }: { serverId: string }): JSX.Element {
  const [policy, setPolicy] = useState<SafetyPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const p = await api<SafetyPolicy>(`/servers/${serverId}/safety-policy`);
      setPolicy(p);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load policy');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function patch(patch: UpdateSafetyPolicyRequest): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const updated = await api<SafetyPolicy>(`/servers/${serverId}/safety-policy`, {
        method: 'PATCH',
        body: patch,
      });
      setPolicy(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  if (!policy) {
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : (
      <p className="text-fg-muted">Loading…</p>
    );
  }

  const Toggle = ({
    label,
    field,
  }: {
    label: string;
    field: keyof Pick<
      SafetyPolicy,
      | 'sfwOnly'
      | 'allowNsfwChannels'
      | 'spoilerTagsEnabled'
      | 'blockExecutableUploads'
      | 'blockArchiveUploads'
      | 'stripImageMetadata'
    >;
  }): JSX.Element => (
    <label className="flex cursor-pointer items-center justify-between rounded border border-subtle px-3 py-2 hover:bg-raised">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={policy[field]}
        disabled={busy}
        onChange={(e) => void patch({ [field]: e.target.checked } as UpdateSafetyPolicyRequest)}
      />
    </label>
  );

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle label="SFW only" field="sfwOnly" />
        <Toggle label="Allow NSFW rooms" field="allowNsfwChannels" />
        <Toggle label="Spoiler tags enabled" field="spoilerTagsEnabled" />
        <Toggle label="Block executable uploads" field="blockExecutableUploads" />
        <Toggle label="Block archive uploads" field="blockArchiveUploads" />
        <Toggle label="Strip image EXIF metadata" field="stripImageMetadata" />
      </div>
      <label className="block">
        <span className="mb-1 inline-block text-fg-muted text-sm">Profanity filter</span>
        <select
          className="input w-40"
          value={policy.profanityFilter}
          disabled={busy}
          onChange={(e) =>
            void patch({
              profanityFilter: e.target.value as 'off' | 'soft' | 'strict',
            })
          }
        >
          <option value="off">Off</option>
          <option value="soft">Soft</option>
          <option value="strict">Strict</option>
        </select>
      </label>
    </div>
  );
}

// ---- Bans -----------------------------------------------------------------

function BansPanel({ serverId }: { serverId: string }): JSX.Element {
  const [bans, setBans] = useState<ServerBan[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [targetUserId, setTargetUserId] = useState('');
  const [reason, setReason] = useState('');
  const [unbanTarget, setUnbanTarget] = useState<ServerBan | null>(null);

  const refresh = (): void => {
    setLoadState('loading');
    api<ServerBan[]>(`/servers/${serverId}/bans`)
      .then((rows) => {
        setBans(rows);
        setLoadState('loaded');
      })
      .catch(() => setLoadState('error'));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const onBan = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    const trimmed = targetUserId.trim();
    if (!trimmed) return;
    try {
      await api(`/servers/${serverId}/bans`, {
        method: 'POST',
        body: {
          userId: trimmed,
          reason: reason.trim() || undefined,
        },
      });
      toast.success('Member banned.');
      setTargetUserId('');
      setReason('');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not ban that member.');
    }
  };

  const onUnban = async (ban: ServerBan): Promise<void> => {
    try {
      await api(`/servers/${serverId}/bans/${ban.userId}`, { method: 'DELETE' });
      toast.success('Ban lifted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not lift the ban.');
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="font-serif text-lg font-medium">Ban a member</h2>
        <p className="text-xs text-fg-muted">
          Banned members are removed from the tavern, their open connections are
          severed, and they cannot rejoin until the ban is lifted.
        </p>
        <form onSubmit={(e) => void onBan(e)} className="flex flex-wrap items-end gap-2">
          <label className="flex-1 text-xs">
            <span className="mb-1 inline-block text-fg-muted">User ID</span>
            <input
              className="input"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              placeholder="01JX…"
              required
            />
          </label>
          <label className="flex-1 text-xs">
            <span className="mb-1 inline-block text-fg-muted">Reason (optional)</span>
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-danger">Ban</button>
        </form>
      </section>

      <section className="space-y-2">
        <h2 className="font-serif text-lg font-medium">
          Active bans
          {loadState === 'loaded' ? ` (${bans.length})` : null}
        </h2>
        {loadState === 'loading' ? (
          <p className="text-xs text-fg-muted">Loading…</p>
        ) : loadState === 'error' ? (
          <p className="text-xs text-fg-muted">Couldn&apos;t load the ban list.</p>
        ) : bans.length === 0 ? (
          <p className="text-xs text-fg-muted">No active bans.</p>
        ) : (
          <ul className="space-y-1">
            {bans.map((b) => (
              <li
                key={b.userId}
                className="flex flex-wrap items-center gap-3 rounded border border-subtle bg-surface px-3 py-2 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate font-mono text-xs">{b.userId}</div>
                  {b.reason ? <div className="text-xs text-fg-muted">{b.reason}</div> : null}
                  <div className="text-xs text-fg-muted">
                    Banned {new Date(b.createdAt).toLocaleString()}
                    {b.expiresAt ? ` · expires ${new Date(b.expiresAt).toLocaleString()}` : ' · permanent'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setUnbanTarget(b)}
                >
                  Lift ban
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {unbanTarget ? (
        <ConfirmDialog
          title="Lift this ban?"
          description={`The user will be able to rejoin via any valid invite.`}
          confirmLabel="Lift ban"
          onCancel={() => setUnbanTarget(null)}
          onConfirm={async () => {
            const target = unbanTarget;
            setUnbanTarget(null);
            await onUnban(target);
          }}
        />
      ) : null}
    </div>
  );
}
