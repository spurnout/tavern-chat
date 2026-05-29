const PENDING_INVITE_KEY = 'tavern.pendingInvite';
const PENDING_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingInvite {
  code: string;
  host: string | null;
  path: string;
  createdAt: number;
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

export function invitePath(code: string, host: string | null = null): string {
  const encodedCode = encodeURIComponent(normalizeInviteCode(code));
  if (!host) return `/invites/${encodedCode}`;
  return `/invites/${encodedCode}?host=${encodeURIComponent(host)}`;
}

export function savePendingInvite(code: string, host: string | null = null): void {
  if (typeof sessionStorage === 'undefined') return;
  const normalized = normalizeInviteCode(code);
  if (!normalized) return;
  const pending: PendingInvite = {
    code: normalized,
    host,
    path: invitePath(normalized, host),
    createdAt: Date.now(),
  };
  try {
    sessionStorage.setItem(PENDING_INVITE_KEY, JSON.stringify(pending));
  } catch {
    /* storage may be disabled; invite entry can still be typed manually */
  }
}

export function readPendingInvite(): PendingInvite | null {
  if (typeof sessionStorage === 'undefined') return null;
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingInvite>;
    if (
      typeof parsed.code !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      clearPendingInvite();
      return null;
    }
    if (!Number.isFinite(parsed.createdAt)) {
      clearPendingInvite();
      return null;
    }
    if (Date.now() - parsed.createdAt > PENDING_INVITE_TTL_MS) {
      clearPendingInvite();
      return null;
    }
    const code = normalizeInviteCode(parsed.code);
    if (!code) {
      clearPendingInvite();
      return null;
    }
    const host =
      typeof parsed.host === 'string' && parsed.host.trim().length > 0
        ? parsed.host.trim()
        : null;
    return {
      code,
      host,
      // Recompute the post-auth path from trusted fields instead of replaying
      // an arbitrary stored URL from sessionStorage.
      path: invitePath(code, host),
      createdAt: parsed.createdAt,
    };
  } catch {
    clearPendingInvite();
    return null;
  }
}

export function clearPendingInvite(): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY);
  } catch {
    /* ignore unavailable storage */
  }
}

export function pendingInviteMatchesCode(pending: PendingInvite, code: string): boolean {
  return pending.code === normalizeInviteCode(code);
}

export function shouldResumePendingInviteAfterRegistration(pending: PendingInvite): boolean {
  // Local instance/server invites are consumed by the registration endpoint.
  // Federated invite links still need to return to the invite page so the
  // logged-in user can review and accept the remote den preview.
  return pending.host !== null;
}
