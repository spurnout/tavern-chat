import { useState } from 'react';
import { Modal } from './Modal.js';
import { api, ApiError, tokenStore } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';
import { useAuth } from '../lib/auth.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Password change form (SEC-003). On success the API revokes every active
 * session for the user — including the one we're holding — so the SPA can't
 * usefully stay signed in. We push the user to /login with a toast.
 */
export function PasswordChangeModal({ open, onOpenChange }: Props): JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const logout = useAuth((s) => s.logout);

  const reset = (): void => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirm('');
    setSubmitting(false);
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (newPassword !== confirm) {
      toast.error('New password and confirmation must match.');
      return;
    }
    if (newPassword === currentPassword) {
      toast.error('New password must differ from current password.');
      return;
    }
    setSubmitting(true);
    try {
      await api('/auth/password', {
        method: 'PATCH',
        body: { currentPassword, newPassword },
      });
      toast.success('Password updated — please sign in with your new password.');
      tokenStore.clear();
      // logout() also clears state and routes back to /login.
      await logout();
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change password.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!submitting) {
          if (!o) reset();
          onOpenChange(o);
        }
      }}
      title="Change password"
      description="You'll be signed out of every session after a successful change."
      footer={
        <>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              if (!submitting) {
                reset();
                onOpenChange(false);
              }
            }}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="password-change-form"
            className="btn-primary"
            disabled={submitting || !currentPassword || !newPassword || !confirm}
          >
            {submitting ? 'Updating…' : 'Update password'}
          </button>
        </>
      }
    >
      <form id="password-change-form" onSubmit={(e) => void onSubmit(e)} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Current password</span>
          <input
            type="password"
            className="input"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            disabled={submitting}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">New password</span>
          <input
            type="password"
            className="input"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={12}
            disabled={submitting}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Confirm new password</span>
          <input
            type="password"
            className="input"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={12}
            disabled={submitting}
          />
        </label>
      </form>
    </Modal>
  );
}
