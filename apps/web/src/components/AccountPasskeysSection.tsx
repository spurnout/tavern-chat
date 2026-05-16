import { useEffect, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface PasskeyRow {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * WebAuthn / passkey management. Lists enrolled credentials and lets the
 * user register a new one. Registration is the standard two-step ceremony:
 *
 *   1. POST /me/webauthn/register/options — server returns a challenge.
 *   2. Browser calls navigator.credentials.create() via @simplewebauthn/browser.
 *   3. POST /me/webauthn/register/verify — server verifies attestation and
 *      persists the credential.
 *
 * Errors at each step surface as toasts; the typical failure mode is the
 * user cancelling the platform UI, which the helper turns into a
 * recognisable `NotAllowedError`.
 */
export function AccountPasskeysSection(): JSX.Element {
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PasskeyRow | null>(null);
  const supported = browserSupportsWebAuthn();

  async function refresh(): Promise<void> {
    try {
      const r = await api<PasskeyRow[]>('/me/webauthn/credentials');
      setRows(r);
    } catch {
      // Silent — section still renders.
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function enroll(): Promise<void> {
    if (!supported) {
      toast.error('This browser does not support passkeys.');
      return;
    }
    setBusy(true);
    try {
      const options = await api<PublicKeyCredentialCreationOptionsJSON>(
        '/me/webauthn/register/options',
        { method: 'POST', body: { deviceName: deviceName.trim() || undefined } },
      );
      const attestation: RegistrationResponseJSON = await startRegistration({
        optionsJSON: options,
      });
      await api('/me/webauthn/register/verify', {
        method: 'POST',
        body: { response: attestation, deviceName: deviceName.trim() || undefined },
      });
      setDeviceName('');
      toast.info('Passkey added.');
      void refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.message);
      } else if (err instanceof Error && err.name === 'NotAllowedError') {
        // User cancelled the system prompt. Don't bark at them about it.
      } else {
        toast.error('Could not enrol the passkey. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: PasskeyRow): Promise<void> {
    setPendingDelete(null);
    setBusy(true);
    try {
      await api(`/me/webauthn/credentials/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
      });
      toast.info('Passkey removed.');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Passkeys</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Sign in with a hardware key or your device&apos;s built-in authenticator (Touch ID, Windows
        Hello, etc.) instead of a one-time code. You can keep TOTP and passkeys both — use whichever
        is handy.
      </p>
      {!supported ? (
        <p className="mt-3 rounded border border-subtle bg-canvas p-3 text-sm text-fg-muted">
          This browser does not advertise WebAuthn support, so passkeys can&apos;t be added here.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="block min-w-[14rem] flex-1">
          <span className="mb-1 inline-block text-fg-muted">Name this passkey (optional)</span>
          <input
            className="input"
            placeholder="e.g. MacBook Touch ID"
            maxLength={120}
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            disabled={busy || !supported}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void enroll()}
          disabled={busy || !supported}
        >
          <KeyRound size={14} className="mr-1.5 inline-block" /> Add passkey
        </button>
      </div>
      {rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-subtle border-t border-subtle">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate">{r.deviceName ?? 'Unnamed passkey'}</div>
                <div className="text-xs text-fg-muted">
                  Added {new Date(r.createdAt).toLocaleDateString()}
                  {r.lastUsedAt ? ` · last used ${new Date(r.lastUsedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost text-danger"
                onClick={() => setPendingDelete(r)}
                disabled={busy}
                aria-label="Remove passkey"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title="Remove this passkey?"
          description={`"${pendingDelete.deviceName ?? 'Unnamed passkey'}" will no longer sign you in. Make sure you have another passkey or 2FA enabled before removing your last one.`}
          confirmLabel="Remove"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
        />
      ) : null}
    </section>
  );
}
