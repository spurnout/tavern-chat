import { useEffect, useState } from 'react';
import { Check, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface TotpStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

interface SetupResponse {
  secret: string;
  otpauthUrl: string;
}

interface VerifyResponse {
  enabled: boolean;
  backupCodes: string[];
}

/**
 * Two-factor authentication settings. Renders the current state, then
 * (depending on state) either the enrolment flow or a disable affordance.
 */
export function AccountSecuritySection(): JSX.Element {
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<TotpStatus>('/me/totp')
      .then((r) => {
        if (!cancelled) setStatus(r);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function startSetup(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<SetupResponse>('/me/totp/setup', { method: 'POST', body: {} });
      setSetup(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<VerifyResponse>('/me/totp/verify', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setStatus({ enabled: true, backupCodesRemaining: r.backupCodes.length });
      setBackupCodes(r.backupCodes);
      setSetup(null);
      setCode('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Code did not match');
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    setBusy(true);
    try {
      await api('/me/totp/disable', { method: 'POST', body: { code: code.trim() } });
      setStatus({ enabled: false, backupCodesRemaining: 0 });
      setBackupCodes(null);
      setCode('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not disable');
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<{ backupCodes: string[] }>('/me/totp/backup-codes', {
        method: 'POST',
        body: { code: code.trim() },
      });
      setBackupCodes(r.backupCodes);
      setCode('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not regenerate');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Two-factor authentication</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Use an authenticator app like Aegis, Authy, or 1Password to add a second step at login.
      </p>
      <div className="mt-3">
        {status === null ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : status.enabled ? (
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2 text-mead">
              <Check size={16} /> 2FA is on. {status.backupCodesRemaining} backup codes remaining.
            </p>
            <label className="block">
              <span className="text-fg-muted">Confirm with a code from your app to make changes</span>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={20}
                className="input mt-1 w-40 font-mono"
                placeholder="123456"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => void regenerate()} disabled={busy}>
                Regenerate backup codes
              </button>
              <button type="button" className="btn-ghost text-danger" onClick={() => void disable()} disabled={busy}>
                Disable 2FA
              </button>
            </div>
            {backupCodes ? <BackupCodes codes={backupCodes} /> : null}
          </div>
        ) : setup ? (
          <div className="space-y-3 text-sm">
            <p>
              Scan this URL with your authenticator app (or paste the secret manually), then enter the
              6-digit code your app generates.
            </p>
            <code className="block break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
              {setup.otpauthUrl}
            </code>
            <code className="block break-all rounded bg-canvas px-2 py-1 font-mono text-xs">
              Secret: {setup.secret}
            </code>
            <label className="block">
              <span className="text-fg-muted">6-digit code</span>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                className="input mt-1 w-40 font-mono"
                placeholder="123456"
              />
            </label>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setSetup(null)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => void confirm()} disabled={busy}>
                Confirm and enable
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-primary text-sm" onClick={() => void startSetup()} disabled={busy}>
            <ShieldAlert size={14} className="mr-1.5 inline-block" /> Set up 2FA
          </button>
        )}
      </div>
    </section>
  );
}

function BackupCodes({ codes }: { codes: string[] }): JSX.Element {
  return (
    <div className="rounded border border-ember bg-tint-ember p-3 text-sm">
      <p className="mb-2 font-medium">
        Save these one-time backup codes. They’re your way back in if you lose your authenticator.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}
