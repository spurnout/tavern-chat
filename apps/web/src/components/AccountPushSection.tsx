import { useEffect, useState } from 'react';
import { Bell, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api-client.js';
import { toast } from '../lib/toast.js';

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface VapidInfo {
  publicKey: string;
}

/**
 * Wave 3 #26 — Web Push subscription management.
 *
 * The backend (PushSubscription model + /api/me/push-subscriptions + the
 * worker push dispatcher) was already wired in an earlier wave; this is
 * the UI affordance that turns it into an actual user feature.
 *
 * Flow when the user clicks "Enable":
 *   1. Make sure the service worker is registered.
 *   2. Fetch the public VAPID key from the API.
 *   3. Ask the browser for a PushSubscription bound to that key.
 *   4. POST the resulting endpoint + keys to /api/me/push-subscriptions.
 *
 * Each browser/device gets its own subscription row, listed below the
 * "Enable" button. Deleting a row unsubscribes that device server-side;
 * the browser-side subscription is best-effort cleaned up via
 * `pushManager.getSubscription().unsubscribe()`.
 */
export function AccountPushSection(): JSX.Element {
  const [rows, setRows] = useState<PushSubscriptionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  async function refresh(): Promise<void> {
    try {
      const r = await api<PushSubscriptionRow[]>('/me/push-subscriptions');
      setRows(r);
    } catch {
      // Section still renders.
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function enable(): Promise<void> {
    if (!supported) {
      toast.error('This browser does not support push notifications.');
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast.info('Notification permission was not granted.');
        return;
      }
      const reg =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register('/sw.js'));
      const vapid = await api<VapidInfo>('/push/vapid-public-key', { retryOn401: false });
      if (!vapid.publicKey) {
        toast.error(
          'This server has no VAPID key configured — push notifications are unavailable.',
        );
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Already subscribed in this browser — make sure the server knows.
        await sendToServer(existing);
        toast.info('Push notifications are already on for this browser.');
        void refresh();
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
      });
      await sendToServer(sub);
      toast.info('Push notifications enabled on this browser.');
      void refresh();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not enable push notifications.';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function disable(row: PushSubscriptionRow): Promise<void> {
    setBusy(true);
    try {
      await api(`/me/push-subscriptions/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
      });
      // Best-effort browser-side unsubscribe — only if the endpoint we're
      // dropping matches the one this browser holds.
      if (supported) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub && sub.endpoint === row.endpoint) {
          await sub.unsubscribe().catch(() => undefined);
        }
      }
      toast.info('Push notifications disabled for that device.');
      void refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not disable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border border-subtle bg-surface p-5">
      <h2 className="font-serif text-lg">Push notifications</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Get a system notification when you&apos;re mentioned or someone DMs you, even when Tavern
        isn&apos;t the active tab. Each browser/device is enabled separately.
      </p>
      {!supported ? (
        <p className="mt-3 rounded border border-subtle bg-canvas p-3 text-sm text-fg-muted">
          This browser does not advertise the Push API, so push can&apos;t be enabled here.
        </p>
      ) : null}
      <div className="mt-3 text-sm">
        <button
          type="button"
          className="btn-primary"
          onClick={() => void enable()}
          disabled={busy || !supported}
        >
          <Bell size={14} className="mr-1.5 inline-block" /> Enable on this browser
        </button>
      </div>
      {rows.length > 0 ? (
        <ul className="mt-4 divide-y divide-subtle border-t border-subtle">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate">{r.userAgent ?? 'Unknown device'}</div>
                <div className="text-xs text-fg-muted">
                  Added {new Date(r.createdAt).toLocaleDateString()}
                  {r.lastUsedAt
                    ? ` · last used ${new Date(r.lastUsedAt).toLocaleDateString()}`
                    : ''}
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost text-danger"
                onClick={() => void disable(r)}
                disabled={busy}
                aria-label="Disable on this device"
                title="Disable"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

async function sendToServer(sub: PushSubscription): Promise<void> {
  const raw = sub.toJSON();
  const keys = raw.keys ?? {};
  await api('/me/push-subscriptions', {
    method: 'POST',
    body: {
      endpoint: sub.endpoint,
      p256dh: keys.p256dh ?? '',
      auth: keys.auth ?? '',
    },
  });
}

/**
 * VAPID public keys arrive base64url-encoded. The browser's
 * `applicationServerKey` expects an ArrayBuffer-backed view; explicitly
 * allocate a plain ArrayBuffer so TS doesn't widen us to ArrayBufferLike
 * (the lib.dom typing rejects SharedArrayBuffer-backed views here).
 */
function urlBase64ToUint8Array(input: string): BufferSource {
  const padding = '='.repeat((4 - (input.length % 4)) % 4);
  const base64 = (input + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bin = typeof atob === 'function' ? atob(base64) : '';
  const buffer = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < bin.length; i += 1) {
    view[i] = bin.charCodeAt(i);
  }
  return view;
}
