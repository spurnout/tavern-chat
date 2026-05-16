import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  PROFILE_LIMITS,
  type SocialLink,
  type UpdateProfileRequest,
  type UserProfile,
} from '@tavern/shared';
import { api, ApiError } from '../lib/api-client.js';
import { useAuth } from '../lib/auth.js';
import { toast } from '../lib/toast.js';
import { Modal } from './Modal.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (profile: UserProfile) => void;
}

const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

function supportedTimezones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Self-only profile edit. Opens from the "Edit profile" button on the
 * member profile card when the viewer clicks their own card. Mirrors the
 * bounds in updateProfileRequestSchema so client-side validation matches
 * what the API will accept.
 */
/** Options for the "Clear custom status after" select. `null` = no expiry. */
const STATUS_EXPIRY_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: "Don't clear", minutes: null },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: 'Today', minutes: 24 * 60 },
  { label: 'This week', minutes: 7 * 24 * 60 },
];

export function EditProfileModal({ open, onOpenChange, onSaved }: Props): JSX.Element {
  const me = useAuth((s) => s.me);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [pronouns, setPronouns] = useState(me?.pronouns ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? '');
  // "Clear after" is purely a relative selector — we compute the absolute
  // ISO timestamp at submit time. Default to "Don't clear" so users who
  // don't care about expiry get the existing behavior.
  const [statusExpiryMinutes, setStatusExpiryMinutes] = useState<number | null>(null);
  const [timezone, setTimezone] = useState(me?.timezone ?? browserTimezone());
  const [accentColor, setAccentColor] = useState(me?.accentColor ?? '#b87333');
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>(me?.socialLinks ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timezones = useMemo(supportedTimezones, []);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);

    // Reject obviously-bad shapes before round-tripping. Server still has
    // the canonical validators; this just spares the user a 400.
    if (accentColor && !ACCENT_PATTERN.test(accentColor)) {
      setError('Accent color must be a #rrggbb hex value.');
      return;
    }
    for (const link of socialLinks) {
      if (link.label.trim().length === 0 || link.url.trim().length === 0) {
        setError('Each link needs both a label and a URL.');
        return;
      }
      try {
        new URL(link.url);
      } catch {
        setError(`"${link.label}" isn't a valid URL.`);
        return;
      }
    }

    const trimmedStatus = customStatus.trim();
    const expiry =
      trimmedStatus.length > 0 && statusExpiryMinutes !== null
        ? new Date(Date.now() + statusExpiryMinutes * 60_000).toISOString()
        : null;

    const body: UpdateProfileRequest = {
      displayName: displayName.trim() || undefined,
      bio: bio.trim().length > 0 ? bio.trim() : null,
      pronouns: pronouns.trim().length > 0 ? pronouns.trim() : null,
      customStatus: trimmedStatus.length > 0 ? trimmedStatus : null,
      customStatusExpiresAt: expiry,
      timezone: timezone.trim().length > 0 ? timezone.trim() : null,
      accentColor: accentColor.trim().length > 0 ? accentColor.trim() : null,
      socialLinks: socialLinks.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
    };

    setSubmitting(true);
    try {
      const profile = await api<UserProfile>('/users/me/profile', {
        method: 'PATCH',
        body,
      });
      // Merge new fields into the in-memory `me` so the rest of the app
      // (sidebar, header, etc.) re-renders without a /auth/me round-trip.
      useAuth.setState((s) => (s.me ? { me: { ...s.me, ...profile } } : s));
      toast.success('Profile saved.');
      onSaved(profile);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save profile.');
      setSubmitting(false);
    }
  };

  const addLink = (): void => {
    if (socialLinks.length >= PROFILE_LIMITS.SOCIAL_LINKS_MAX) return;
    setSocialLinks([...socialLinks, { label: '', url: '' }]);
  };

  const updateLink = (index: number, patch: Partial<SocialLink>): void => {
    setSocialLinks(socialLinks.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  };

  const removeLink = (index: number): void => {
    setSocialLinks(socialLinks.filter((_, i) => i !== index));
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!submitting) onOpenChange(o);
      }}
      title="Edit profile"
      description="What other members see when they pull up your chair."
      widthClass="w-[min(95vw,560px)]"
      footer={
        <>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="edit-profile-form"
            className="btn-primary"
            disabled={submitting}
          >
            {submitting ? 'Saving…' : 'Save profile'}
          </button>
        </>
      }
    >
      <form
        id="edit-profile-form"
        onSubmit={(e) => void onSubmit(e)}
        className="space-y-3"
      >
        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Display name</span>
          <input
            type="text"
            className="input"
            value={displayName}
            maxLength={32}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={submitting}
          />
        </label>

        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">Pronouns</span>
          <input
            type="text"
            className="input"
            value={pronouns}
            maxLength={PROFILE_LIMITS.PRONOUNS_MAX}
            placeholder="she/her, they/them, …"
            onChange={(e) => setPronouns(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Custom status</span>
            <input
              type="text"
              className="input"
              value={customStatus}
              maxLength={PROFILE_LIMITS.CUSTOM_STATUS_MAX}
              placeholder="Quietly reading by the fire"
              onChange={(e) => setCustomStatus(e.target.value)}
              disabled={submitting}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Clear after</span>
            <select
              className="input"
              value={statusExpiryMinutes === null ? 'none' : String(statusExpiryMinutes)}
              onChange={(e) =>
                setStatusExpiryMinutes(e.target.value === 'none' ? null : Number(e.target.value))
              }
              disabled={submitting || customStatus.trim().length === 0}
            >
              {STATUS_EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.minutes === null ? 'none' : String(opt.minutes)}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-sm">
          <span className="mb-1 inline-block text-fg-muted">About</span>
          <textarea
            className="input min-h-[80px]"
            value={bio}
            maxLength={500}
            onChange={(e) => setBio(e.target.value)}
            disabled={submitting}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Timezone</span>
            {timezones.length > 0 ? (
              <select
                className="input"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={submitting}
              >
                <option value="">No timezone</option>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="input"
                value={timezone}
                maxLength={PROFILE_LIMITS.TIMEZONE_MAX}
                placeholder="Europe/Paris"
                onChange={(e) => setTimezone(e.target.value)}
                disabled={submitting}
              />
            )}
          </label>

          <label className="block text-sm">
            <span className="mb-1 inline-block text-fg-muted">Accent color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                className="h-10 w-12 cursor-pointer rounded border border-subtle bg-canvas"
                value={ACCENT_PATTERN.test(accentColor) ? accentColor : '#b87333'}
                onChange={(e) => setAccentColor(e.target.value)}
                disabled={submitting}
              />
              <input
                type="text"
                className="input"
                value={accentColor}
                maxLength={7}
                placeholder="#b87333"
                onChange={(e) => setAccentColor(e.target.value)}
                disabled={submitting}
              />
            </div>
          </label>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="text-fg-muted">Links</span>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={addLink}
              disabled={submitting || socialLinks.length >= PROFILE_LIMITS.SOCIAL_LINKS_MAX}
            >
              <Plus size={12} className="mr-1 inline-block" />
              Add link
            </button>
          </div>
          <ul className="space-y-2">
            {socialLinks.map((link, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  className="input w-32"
                  placeholder="Label"
                  value={link.label}
                  maxLength={PROFILE_LIMITS.SOCIAL_LINK_LABEL_MAX}
                  onChange={(e) => updateLink(idx, { label: e.target.value })}
                  disabled={submitting}
                />
                <input
                  type="url"
                  className="input flex-1"
                  placeholder="https://example.com"
                  value={link.url}
                  maxLength={PROFILE_LIMITS.SOCIAL_LINK_URL_MAX}
                  onChange={(e) => updateLink(idx, { url: e.target.value })}
                  disabled={submitting}
                />
                <button
                  type="button"
                  className="rounded p-2 text-fg-muted hover:bg-raised"
                  aria-label={`Remove link ${link.label || idx + 1}`}
                  onClick={() => removeLink(idx)}
                  disabled={submitting}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {socialLinks.length === 0 ? (
              <li className="text-sm text-fg-muted">No links yet.</li>
            ) : null}
          </ul>
        </div>

        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </form>
    </Modal>
  );
}
