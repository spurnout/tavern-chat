import { z } from 'zod';
import { idSchema } from './ids.js';

export const reportTargetTypeSchema = z.enum([
  'message',
  'attachment',
  'profile',
  'emoji',
  'campaign_note',
  'handout',
  'voice_message',
]);

export const reportCategorySchema = z.enum([
  'suspected_child_exploitation_or_csam',
  'non_consensual_intimate_material',
  'credible_threat_or_violent_coordination',
  'stalking_swatting_or_targeted_harassment',
  'doxxing_or_private_information',
  'malware_phishing_or_credential_theft',
  'illegal_marketplace_or_trafficking',
  'fraud_or_scam',
  'spam_or_raid',
  'policy_evasion',
  'other_serious_abuse',
]);

export const reportStatusSchema = z.enum([
  'open',
  'in_review',
  'resolved',
  'dismissed',
  'escalated',
]);

export const moderationActionSchema = z.enum([
  'allow',
  'allow_with_label',
  'content_warning',
  'blur',
  'warn_user',
  'hold_for_review',
  'block',
  'quarantine',
  'lock_account',
  'report_workflow',
]);

export const reportSchema = z.object({
  id: idSchema,
  serverId: idSchema.nullable(),
  reporterId: idSchema,
  targetType: reportTargetTypeSchema,
  targetId: idSchema,
  category: reportCategorySchema,
  notes: z.string().max(2000).nullable(),
  status: reportStatusSchema,
  resolvedById: idSchema.nullable(),
  resolutionNotes: z.string().max(4000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createReportRequestSchema = z.object({
  targetType: reportTargetTypeSchema,
  targetId: idSchema,
  category: reportCategorySchema,
  serverId: idSchema.optional(),
  notes: z.string().max(2000).optional(),
});

export const resolveReportRequestSchema = z.object({
  status: z.enum(['resolved', 'dismissed', 'escalated']),
  action: moderationActionSchema.optional(),
  notes: z.string().max(4000).optional(),
});

// ---- Audit log -------------------------------------------------------------

export const auditLogActionSchema = z.enum([
  'server.created',
  'server.updated',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'role.created',
  'role.updated',
  'role.deleted',
  'role.assigned',
  'role.revoked',
  'member.joined',
  'member.left',
  'member.kicked',
  'member.banned',
  'member.unbanned',
  'member.timed_out',
  'message.deleted',
  'message.held',
  'message.released',
  'message.quarantined',
  'attachment.blocked',
  'attachment.quarantined',
  'attachment.released',
  'invite.created',
  'invite.revoked',
  'report.created',
  'report.resolved',
  'safety_policy.updated',
  'instance_safety_policy.updated',
  'campaign.created',
  'campaign.updated',
  'campaign.archived',
  'session.created',
  'session.updated',
  'game_night.created',
  'game_night.updated',
  'user.posting_locked',
  'user.posting_unlocked',
  'user.uploads_locked',
  'user.uploads_unlocked',
]);

export const auditLogEntrySchema = z.object({
  id: idSchema,
  serverId: idSchema.nullable(),
  actorId: idSchema.nullable(),
  action: auditLogActionSchema,
  targetType: z.string().max(64).nullable(),
  targetId: idSchema.nullable(),
  metadata: z.unknown(),
  createdAt: z.string().datetime(),
});

// ---- Server safety policy --------------------------------------------------

export const safetyPolicySchema = z.object({
  serverId: idSchema,
  sfwOnly: z.boolean(),
  allowNsfwChannels: z.boolean(),
  spoilerTagsEnabled: z.boolean(),
  profanityFilter: z.enum(['off', 'soft', 'strict']),
  uploadDomainAllowlist: z.array(z.string().min(1).max(128)),
  uploadDomainBlocklist: z.array(z.string().min(1).max(128)),
  blockExecutableUploads: z.boolean(),
  blockArchiveUploads: z.boolean(),
  stripImageMetadata: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const updateSafetyPolicyRequestSchema = safetyPolicySchema
  .omit({ serverId: true, updatedAt: true })
  .partial();

export type ReportTargetType = z.infer<typeof reportTargetTypeSchema>;
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export type ReportStatus = z.infer<typeof reportStatusSchema>;
export type ModerationAction = z.infer<typeof moderationActionSchema>;
export type Report = z.infer<typeof reportSchema>;
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;
export type ResolveReportRequest = z.infer<typeof resolveReportRequestSchema>;
export type AuditLogAction = z.infer<typeof auditLogActionSchema>;
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;
export type SafetyPolicy = z.infer<typeof safetyPolicySchema>;
export type UpdateSafetyPolicyRequest = z.infer<typeof updateSafetyPolicyRequestSchema>;
