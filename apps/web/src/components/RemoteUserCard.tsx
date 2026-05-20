/**
 * Presentation-only card for remote (federated) user profiles.
 * Rendered inside a Popover when a qualified mention is hovered/clicked.
 */

export interface RemoteUserCardData {
  remoteUserId: string;
  displayName: string;
  avatarUrl: string | null;
  homeInstanceHost: string;
  publicKey: string;
  lastSeenAt: string;
}

interface Props {
  loading: boolean;
  error: string | null;
  data: RemoteUserCardData | null;
}

export function RemoteUserCard({ loading, error, data }: Props): JSX.Element {
  return (
    <div className="w-64 rounded-lg border border-subtle bg-surface p-4 shadow-xl">
      {loading ? (
        <p className="text-sm text-fg-muted">Loading remote profile…</p>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : data ? (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <RemoteAvatar avatarUrl={data.avatarUrl} fallback={data.displayName} />
            <div className="min-w-0">
              <div className="truncate font-medium">{data.displayName}</div>
              <div className="truncate text-xs text-fg-muted">{data.remoteUserId}</div>
            </div>
          </div>
          <div className="rounded bg-sunken p-2 text-xs text-fg-muted">
            <div className="font-medium text-fg">From another Tavern</div>
            <div>{data.homeInstanceHost}</div>
          </div>
          <div className="text-xs text-fg-muted">
            Last seen:{' '}
            <time dateTime={data.lastSeenAt}>{formatRelative(data.lastSeenAt)}</time>
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">No data.</p>
      )}
    </div>
  );
}

function RemoteAvatar({
  avatarUrl,
  fallback,
}: {
  avatarUrl: string | null;
  fallback: string;
}): JSX.Element {
  if (avatarUrl) {
    return <img src={avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />;
  }
  const initial = fallback.charAt(0).toUpperCase();
  return (
    <div className="grid h-10 w-10 place-items-center rounded-full bg-raised text-fg-muted">
      {initial}
    </div>
  );
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
