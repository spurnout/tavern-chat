# Trust & Safety

> Tavern includes built-in local trust and safety tooling for access control,
> upload hygiene, reporting, quarantine, audit logs, and configurable community
> policies.

Tavern **does not**:

- Use any AI moderation provider.
- Send your content to any external service.
- Claim to detect all illegal content automatically.
- Replace operator/community judgment.

What Tavern *does* provide is a deterministic, auditable scaffolding around the
content people post on your instance, plus configuration knobs for community
policy. Operators are responsible for actually moderating their communities and
for compliance with applicable law.

## Layers

### Access control

- Invite-only registration. The instance can be locked entirely with
  `ALLOW_PUBLIC_REGISTRATION=false`.
- Per-server invites with optional expiry and use limits.
- Member timeouts (`TIMEOUT_MEMBERS`), kicks (`KICK_MEMBERS`), bans
  (`BAN_MEMBERS`).
- Per-user posting / upload locks (`LOCK_USER_POSTING`, `LOCK_USER_UPLOADS`)
  — a moderator can silence a single user without removing them.

### Upload hygiene

Every upload runs through the worker pipeline:

1. **MIME allowlist** + magic-byte check. We do not trust the `Content-Type`
   header.
2. **Extension blocklist** (executables + archives, configurable).
3. **ClamAV scan**. With `ALLOW_UNSCANNED_UPLOADS=false` (the default), files
   that cannot be scanned are rejected, not quietly let through.
4. **Image normalization** via sharp. EXIF metadata is stripped by default.
5. **SVG is rejected** — too risky for inline rendering.
6. On any failure the attachment is moved to the quarantine bucket and its
   status flipped to `quarantined` or `blocked`.

### Reporting

Anything user-generated is reportable:

- messages
- attachments
- profiles
- emoji
- campaign notes
- handouts
- voice messages

Reports require selecting one of the [report categories](#report-categories).
Reports land in the moderation queue (`VIEW_MODERATION_QUEUE`). Resolutions
write to the audit log.

### Quarantine

Quarantined attachments live in a separate bucket
(`S3_QUARANTINE_BUCKET`) with no public access. The frontend never renders
them inline; the API does not produce thumbnails for them. Only members with
`MANAGE_QUARANTINE` see them, behind explicit "Reveal" affordances in the UI.

### Audit log

Every moderation action — and every server / channel / role / member /
campaign / game-night change — writes an entry to `AuditLogEntry`. The audit
log is append-only; entries cannot be edited or deleted via the API.

### Server safety policy

Each server has a `SafetyPolicy` row. Operators can toggle:

- `sfwOnly`, `allowNsfwChannels`
- `spoilerTagsEnabled`
- `profanityFilter` (off / soft / strict)
- `uploadDomainAllowlist`, `uploadDomainBlocklist`
- `blockExecutableUploads`, `blockArchiveUploads`
- `stripImageMetadata`

Instance-wide defaults live in environment variables; server policies layer on
top.

### Tabletop boundaries

Campaigns carry a `safetyBoundariesJson` field that captures lines and veils
explicitly. Each entry has a topic + an action, e.g.:

```json
[
  { "topic": "romance",       "action": "fade_to_black" },
  { "topic": "graphic_horror","action": "content_warning" },
  { "topic": "torture",       "action": "block" },
  { "topic": "spiders",       "action": "content_warning" },
  { "topic": "pvp_conflict",  "action": "requires_consent" }
]
```

Posting a dice roll or message to a campaign channel can warn the GM or block
the action when these are configured (Phase 4 polish).

## Report categories

Defined in [`packages/shared/src/schemas/moderation.ts`](../packages/shared/src/schemas/moderation.ts):

- `suspected_child_exploitation_or_csam`
- `non_consensual_intimate_material`
- `credible_threat_or_violent_coordination`
- `stalking_swatting_or_targeted_harassment`
- `doxxing_or_private_information`
- `malware_phishing_or_credential_theft`
- `illegal_marketplace_or_trafficking`
- `fraud_or_scam`
- `spam_or_raid`
- `policy_evasion`
- `other_serious_abuse`

These names are deliberately specific. They drive UI copy, queue routing, and
audit log entries.

## Moderation actions

Actions that a moderator can take on a piece of content or a user:

- `allow`
- `allow_with_label`
- `content_warning`
- `blur`
- `warn_user`
- `hold_for_review`
- `block`
- `quarantine`
- `lock_account`
- `report_workflow`

## What to do about CSAM

Tavern cannot detect CSAM and does not claim to. If a report comes in, the
expected operator workflow is:

1. **Quarantine immediately** (one-click action from the queue).
2. Lock the uploader's account (`LOCK_USER_POSTING`, `LOCK_USER_UPLOADS`).
3. Preserve the audit log + relevant attachment metadata.
4. Report to the appropriate authority for your jurisdiction (in the US:
   [NCMEC CyberTipline](https://report.cybertip.org/)).
5. Do not view, share, or further distribute the material.

This is a generic scaffolding statement, not legal advice. Operators should
have their own incident response plan.
