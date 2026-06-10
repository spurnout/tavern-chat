import { useEffect, useState } from 'react';
import type { Role } from '@tavern/shared';
import {
  Permission,
  combine,
  parsePermissions,
  serializePermissions,
} from '@tavern/shared';
import { api, ApiError } from '../../lib/api-client.js';
import { ConfirmDialog } from '../ConfirmDialog.js';

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
  { flag: Permission.MANAGE_SERVER, label: 'Manage tavern' },
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

export function RolesPanel({ serverId }: { serverId: string }): JSX.Element {
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Role | null>(null);
  const [roleToDelete, setRoleToDelete] = useState<Role | null>(null);

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
    setBusy(true);
    try {
      await api(`/roles/${role.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    } finally {
      setBusy(false);
      setRoleToDelete(null);
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
                  onClick={() => setRoleToDelete(r)}
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
      {roleToDelete ? (
        <ConfirmDialog
          title="Delete role?"
          description={`Delete "${roleToDelete.name}"? Members with this role will lose its permissions.`}
          confirmLabel="Delete role"
          destructive
          onConfirm={() => void deleteRole(roleToDelete)}
          onCancel={() => setRoleToDelete(null)}
        />
      ) : null}
    </div>
  );
}
