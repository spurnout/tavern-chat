import { z } from 'zod';
import { idSchema } from './ids.js';
import { usernameSchema } from './auth.js';
import { presenceSchema } from './presence.js';
import { NAME_LIMITS } from '../constants.js';

// Bounds for the rich-profile fields. Kept here so server validators and
// client forms agree on byte limits without duplication.
export const PROFILE_LIMITS = {
  PRONOUNS_MAX: 32,
  TIMEZONE_MAX: 64,
  CUSTOM_STATUS_MAX: 128,
  SOCIAL_LINK_LABEL_MAX: 32,
  SOCIAL_LINK_URL_MAX: 256,
  SOCIAL_LINKS_MAX: 5,
} as const;

const accentColorPattern = /^#[0-9a-fA-F]{6}$/;
export const accentColorSchema = z.string().regex(accentColorPattern);

// `z.string().url()` accepts *any* URL-shaped string, including `javascript:`,
// `data:`, `vbscript:`, `file:`, etc. Profile social links are rendered as
// `href` attributes on the profile card, so we restrict them to schemes that
// are safe to navigate to from a click.
const SAFE_PROFILE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export const profileLinkUrlSchema = z
  .string()
  .max(PROFILE_LIMITS.SOCIAL_LINK_URL_MAX)
  .url()
  .refine(
    (value) => {
      try {
        return SAFE_PROFILE_LINK_PROTOCOLS.has(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'Only http(s):// and mailto: URLs are allowed' },
  );

export const socialLinkSchema = z.object({
  label: z.string().min(1).max(PROFILE_LIMITS.SOCIAL_LINK_LABEL_MAX),
  url: profileLinkUrlSchema,
});

export const userSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  displayName: z.string().min(NAME_LIMITS.MIN_DISPLAY_NAME).max(NAME_LIMITS.MAX_DISPLAY_NAME),
  avatarAttachmentId: idSchema.nullable(),
  bio: z.string().max(500).nullable(),
  presence: presenceSchema.default('offline'),
  createdAt: z.string().datetime(),
});

// Rich profile returned by GET /api/users/:userId/profile.
// Member rows in the sidebar stay lean (userSchema shape); the popover lazily
// fetches this when first opened.
// Mutual servers surfaced on the card so a viewer can see which taverns
// they share with the target user. Empty for self-lookups (you're in
// every server you're in, by definition — surfacing it on your own card
// would be noise).
export const mutualServerSchema = z.object({
  id: idSchema,
  name: z.string(),
  iconAttachmentId: idSchema.nullable(),
});

export const userProfileSchema = userSchema.extend({
  pronouns: z.string().max(PROFILE_LIMITS.PRONOUNS_MAX).nullable(),
  accentColor: accentColorSchema.nullable(),
  timezone: z.string().max(PROFILE_LIMITS.TIMEZONE_MAX).nullable(),
  customStatus: z.string().max(PROFILE_LIMITS.CUSTOM_STATUS_MAX).nullable(),
  customStatusExpiresAt: z.string().datetime().nullable(),
  socialLinks: z.array(socialLinkSchema).max(PROFILE_LIMITS.SOCIAL_LINKS_MAX),
  mutualServers: z.array(mutualServerSchema),
});

export const meSchema = userProfileSchema.extend({
  email: z.string().email(),
  isInstanceAdmin: z.boolean(),
  postingLockedUntil: z.string().datetime().nullable(),
  uploadsLockedUntil: z.string().datetime().nullable(),
  manualDnd: z.boolean(),
  // Federation polish (post-Phase 6): per-user opt-outs. Always present in
  // the Me payload so the account-settings page can render the current state
  // without a second round-trip.
  acceptsFederatedDms: z.boolean(),
  acceptsFederatedPresence: z.boolean(),
});

/**
 * Account-level settings — the shape returned by `GET /api/me/account` and
 * accepted by `PATCH /api/me/account`. Distinct from the profile shape
 * (`updateProfileRequestSchema`) which carries display-facing fields like
 * `displayName`, `bio`, `avatar`. Account settings are non-profile
 * preferences that affect how the account behaves at the instance / federation
 * boundary.
 *
 * Phase-6-polish set: federation privacy toggles. Future account-level
 * preferences (locale, theme, etc.) can be added here without inflating the
 * profile-edit surface.
 */
export const accountSettingsSchema = z.object({
  acceptsFederatedDms: z.boolean(),
  acceptsFederatedPresence: z.boolean(),
});

export const updateAccountSettingsRequestSchema = z.object({
  acceptsFederatedDms: z.boolean().optional(),
  acceptsFederatedPresence: z.boolean().optional(),
});

export const updateProfileRequestSchema = z.object({
  displayName: z
    .string()
    .min(NAME_LIMITS.MIN_DISPLAY_NAME)
    .max(NAME_LIMITS.MAX_DISPLAY_NAME)
    .optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarAttachmentId: idSchema.nullable().optional(),
  pronouns: z.string().max(PROFILE_LIMITS.PRONOUNS_MAX).nullable().optional(),
  accentColor: accentColorSchema.nullable().optional(),
  timezone: z.string().max(PROFILE_LIMITS.TIMEZONE_MAX).nullable().optional(),
  customStatus: z.string().max(PROFILE_LIMITS.CUSTOM_STATUS_MAX).nullable().optional(),
  customStatusExpiresAt: z.string().datetime().nullable().optional(),
  socialLinks: z.array(socialLinkSchema).max(PROFILE_LIMITS.SOCIAL_LINKS_MAX).optional(),
});

export const updateMemberNicknameRequestSchema = z.object({
  nickname: z
    .string()
    .min(NAME_LIMITS.MIN_DISPLAY_NAME)
    .max(NAME_LIMITS.MAX_DISPLAY_NAME)
    .nullable(),
});

export type User = z.infer<typeof userSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type SocialLink = z.infer<typeof socialLinkSchema>;
export type MutualServer = z.infer<typeof mutualServerSchema>;
export type Me = z.infer<typeof meSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;
export type UpdateMemberNicknameRequest = z.infer<typeof updateMemberNicknameRequestSchema>;
export type AccountSettings = z.infer<typeof accountSettingsSchema>;
export type UpdateAccountSettingsRequest = z.infer<typeof updateAccountSettingsRequestSchema>;
