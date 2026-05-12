-- CreateEnum
CREATE TYPE "InviteScope" AS ENUM ('instance', 'server');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('category', 'text', 'voice', 'campaign', 'session', 'board_game');

-- CreateEnum
CREATE TYPE "OverwriteTargetType" AS ENUM ('role', 'user');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('default', 'system', 'voice', 'dice_roll', 'session_event');

-- CreateEnum
CREATE TYPE "SafetyState" AS ENUM ('allowed', 'labeled', 'warning', 'blurred', 'held', 'quarantined', 'blocked');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('image', 'gif', 'video', 'audio', 'voice_message', 'map', 'handout', 'character_asset', 'file');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('pending', 'uploaded', 'processing', 'ready', 'failed', 'blocked', 'quarantined');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('planning', 'active', 'paused', 'completed', 'archived');

-- CreateEnum
CREATE TYPE "CampaignRole" AS ENUM ('player', 'co_gm');

-- CreateEnum
CREATE TYPE "CampaignSessionStatus" AS ENUM ('planned', 'live', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "RsvpStatus" AS ENUM ('yes', 'no', 'maybe', 'late');

-- CreateEnum
CREATE TYPE "NoteVisibility" AS ENUM ('public_to_party', 'gm_only');

-- CreateEnum
CREATE TYPE "HandoutVisibility" AS ENUM ('public_to_party', 'gm_only', 'specific_players');

-- CreateEnum
CREATE TYPE "DiceVisibility" AS ENUM ('public', 'gm_only', 'private');

-- CreateEnum
CREATE TYPE "GameNightStatus" AS ENUM ('planning', 'scheduled', 'live', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ReportTargetType" AS ENUM ('message', 'attachment', 'profile', 'emoji', 'campaign_note', 'handout', 'voice_message');

-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('suspected_child_exploitation_or_csam', 'non_consensual_intimate_material', 'credible_threat_or_violent_coordination', 'stalking_swatting_or_targeted_harassment', 'doxxing_or_private_information', 'malware_phishing_or_credential_theft', 'illegal_marketplace_or_trafficking', 'fraud_or_scam', 'spam_or_raid', 'policy_evasion', 'other_serious_abuse');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'in_review', 'resolved', 'dismissed', 'escalated');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "usernameLower" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailLower" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarAttachmentId" TEXT,
    "bio" TEXT,
    "isInstanceAdmin" BOOLEAN NOT NULL DEFAULT false,
    "postingLockedUntil" TIMESTAMP(3),
    "uploadsLockedUntil" TIMESTAMP(3),
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "loginLockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scope" "InviteScope" NOT NULL,
    "serverId" TEXT,
    "channelId" TEXT,
    "createdById" TEXT,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "iconAttachmentId" TEXT,
    "defaultRoleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerMember" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nickname" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timeoutUntil" TIMESTAMP(3),

    CONSTRAINT "ServerMember_pkey" PRIMARY KEY ("serverId","userId")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "permissions" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "mentionable" BOOLEAN NOT NULL DEFAULT false,
    "hoist" BOOLEAN NOT NULL DEFAULT false,
    "isEveryone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerMemberRole" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerMemberRole_pkey" PRIMARY KEY ("serverId","userId","roleId")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "parentId" TEXT,
    "campaignId" TEXT,
    "gameNightId" TEXT,
    "type" "ChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "nsfw" BOOLEAN NOT NULL DEFAULT false,
    "videoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionOverwrite" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "targetType" "OverwriteTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "allow" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "deny" DECIMAL(20,0) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionOverwrite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'default',
    "content" TEXT NOT NULL DEFAULT '',
    "replyToMessageId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "safetyState" "SafetyState" NOT NULL DEFAULT 'allowed',
    "diceRollId" TEXT,
    "nonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "serverId" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "kind" "AttachmentKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "waveform" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "storageBucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "scanResult" JSONB,
    "scannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageReaction" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("messageId","userId","emoji")
);

-- CreateTable
CREATE TABLE "CustomEmoji" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomEmoji_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceState" (
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT,
    "selfMute" BOOLEAN NOT NULL DEFAULT false,
    "selfDeaf" BOOLEAN NOT NULL DEFAULT false,
    "serverMute" BOOLEAN NOT NULL DEFAULT false,
    "serverDeaf" BOOLEAN NOT NULL DEFAULT false,
    "cameraOn" BOOLEAN NOT NULL DEFAULT false,
    "screenSharing" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceState_pkey" PRIMARY KEY ("serverId","userId")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "gameSystem" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'planning',
    "gmUserId" TEXT NOT NULL,
    "defaultChannelId" TEXT,
    "rulesJson" JSONB,
    "safetyBoundariesJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignMember" (
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CampaignRole" NOT NULL DEFAULT 'player',
    "characterName" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignMember_pkey" PRIMARY KEY ("campaignId","userId")
);

-- CreateTable
CREATE TABLE "CampaignSession" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "voiceChannelId" TEXT,
    "textChannelId" TEXT,
    "status" "CampaignSessionStatus" NOT NULL DEFAULT 'planned',
    "agenda" TEXT,
    "recap" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSessionRsvp" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL DEFAULT 'maybe',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignSessionRsvp_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateTable
CREATE TABLE "CampaignNote" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "NoteVisibility" NOT NULL DEFAULT 'public_to_party',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handout" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "visibility" "HandoutVisibility" NOT NULL DEFAULT 'public_to_party',
    "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoutVisibleUser" (
    "handoutId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "HandoutVisibleUser_pkey" PRIMARY KEY ("handoutId","userId")
);

-- CreateTable
CREATE TABLE "DiceRoll" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notation" TEXT NOT NULL,
    "label" TEXT,
    "resultJson" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "visibility" "DiceVisibility" NOT NULL DEFAULT 'public',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiceRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardGame" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minPlayers" INTEGER NOT NULL,
    "maxPlayers" INTEGER NOT NULL,
    "playTimeMinutes" INTEGER,
    "complexity" DOUBLE PRECISION,
    "ownerUserId" TEXT,
    "coverAttachmentId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameNight" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledStart" TIMESTAMP(3),
    "scheduledEnd" TIMESTAMP(3),
    "location" TEXT,
    "voiceChannelId" TEXT,
    "textChannelId" TEXT,
    "selectedBoardGameId" TEXT,
    "status" "GameNightStatus" NOT NULL DEFAULT 'planning',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameNight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameNightCandidate" (
    "gameNightId" TEXT NOT NULL,
    "boardGameId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameNightCandidate_pkey" PRIMARY KEY ("gameNightId","boardGameId")
);

-- CreateTable
CREATE TABLE "GameNightVote" (
    "gameNightId" TEXT NOT NULL,
    "boardGameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "votedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameNightVote_pkey" PRIMARY KEY ("gameNightId","userId")
);

-- CreateTable
CREATE TABLE "GameNightRsvp" (
    "gameNightId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "RsvpStatus" NOT NULL DEFAULT 'maybe',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameNightRsvp_pkey" PRIMARY KEY ("gameNightId","userId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "reporterId" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "category" "ReportCategory" NOT NULL,
    "notes" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModerationAction" (
    "id" TEXT NOT NULL,
    "reportId" TEXT,
    "moderatorId" TEXT NOT NULL,
    "serverId" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SafetyPolicy" (
    "serverId" TEXT NOT NULL,
    "sfwOnly" BOOLEAN NOT NULL DEFAULT false,
    "allowNsfwChannels" BOOLEAN NOT NULL DEFAULT true,
    "spoilerTagsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "profanityFilter" TEXT NOT NULL DEFAULT 'off',
    "uploadDomainAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uploadDomainBlocklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockExecutableUploads" BOOLEAN NOT NULL DEFAULT true,
    "blockArchiveUploads" BOOLEAN NOT NULL DEFAULT true,
    "stripImageMetadata" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SafetyPolicy_pkey" PRIMARY KEY ("serverId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_usernameLower_key" ON "User"("usernameLower");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_emailLower_key" ON "User"("emailLower");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_code_key" ON "Invite"("code");

-- CreateIndex
CREATE INDEX "Invite_serverId_idx" ON "Invite"("serverId");

-- CreateIndex
CREATE INDEX "Invite_code_idx" ON "Invite"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Server_defaultRoleId_key" ON "Server"("defaultRoleId");

-- CreateIndex
CREATE INDEX "Server_ownerUserId_idx" ON "Server"("ownerUserId");

-- CreateIndex
CREATE INDEX "ServerMember_userId_idx" ON "ServerMember"("userId");

-- CreateIndex
CREATE INDEX "Role_serverId_idx" ON "Role"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_serverId_name_key" ON "Role"("serverId", "name");

-- CreateIndex
CREATE INDEX "ServerMemberRole_roleId_idx" ON "ServerMemberRole"("roleId");

-- CreateIndex
CREATE INDEX "Channel_serverId_position_idx" ON "Channel"("serverId", "position");

-- CreateIndex
CREATE INDEX "Channel_parentId_idx" ON "Channel"("parentId");

-- CreateIndex
CREATE INDEX "PermissionOverwrite_channelId_idx" ON "PermissionOverwrite"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionOverwrite_channelId_targetType_targetId_key" ON "PermissionOverwrite"("channelId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_diceRollId_key" ON "Message"("diceRollId");

-- CreateIndex
CREATE INDEX "Message_channelId_createdAt_idx" ON "Message"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_authorId_idx" ON "Message"("authorId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_channelId_nonce_key" ON "Message"("channelId", "nonce");

-- CreateIndex
CREATE INDEX "Attachment_uploaderId_idx" ON "Attachment"("uploaderId");

-- CreateIndex
CREATE INDEX "Attachment_status_idx" ON "Attachment"("status");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "MessageReaction_messageId_emoji_idx" ON "MessageReaction"("messageId", "emoji");

-- CreateIndex
CREATE UNIQUE INDEX "CustomEmoji_attachmentId_key" ON "CustomEmoji"("attachmentId");

-- CreateIndex
CREATE INDEX "CustomEmoji_serverId_idx" ON "CustomEmoji"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomEmoji_serverId_name_key" ON "CustomEmoji"("serverId", "name");

-- CreateIndex
CREATE INDEX "VoiceState_channelId_idx" ON "VoiceState"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_defaultChannelId_key" ON "Campaign"("defaultChannelId");

-- CreateIndex
CREATE INDEX "Campaign_serverId_idx" ON "Campaign"("serverId");

-- CreateIndex
CREATE INDEX "Campaign_gmUserId_idx" ON "Campaign"("gmUserId");

-- CreateIndex
CREATE INDEX "CampaignMember_userId_idx" ON "CampaignMember"("userId");

-- CreateIndex
CREATE INDEX "CampaignSession_campaignId_scheduledStart_idx" ON "CampaignSession"("campaignId", "scheduledStart");

-- CreateIndex
CREATE INDEX "CampaignNote_campaignId_pinned_idx" ON "CampaignNote"("campaignId", "pinned");

-- CreateIndex
CREATE INDEX "Handout_campaignId_idx" ON "Handout"("campaignId");

-- CreateIndex
CREATE INDEX "DiceRoll_channelId_createdAt_idx" ON "DiceRoll"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "BoardGame_serverId_name_idx" ON "BoardGame"("serverId", "name");

-- CreateIndex
CREATE INDEX "GameNight_serverId_scheduledStart_idx" ON "GameNight"("serverId", "scheduledStart");

-- CreateIndex
CREATE INDEX "GameNightCandidate_boardGameId_idx" ON "GameNightCandidate"("boardGameId");

-- CreateIndex
CREATE INDEX "GameNightVote_gameNightId_boardGameId_idx" ON "GameNightVote"("gameNightId", "boardGameId");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_serverId_status_idx" ON "Report"("serverId", "status");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "ModerationAction_targetType_targetId_idx" ON "ModerationAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_serverId_createdAt_idx" ON "AuditLogEntry"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLogEntry_action_idx" ON "AuditLogEntry"("action");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_defaultRoleId_fkey" FOREIGN KEY ("defaultRoleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMember" ADD CONSTRAINT "ServerMember_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMember" ADD CONSTRAINT "ServerMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMemberRole" ADD CONSTRAINT "ServerMemberRole_serverId_userId_fkey" FOREIGN KEY ("serverId", "userId") REFERENCES "ServerMember"("serverId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMemberRole" ADD CONSTRAINT "ServerMemberRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMemberRole" ADD CONSTRAINT "ServerMemberRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_gameNightId_fkey" FOREIGN KEY ("gameNightId") REFERENCES "GameNight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionOverwrite" ADD CONSTRAINT "PermissionOverwrite_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionOverwrite" ADD CONSTRAINT "PermissionOverwrite_role_fkey" FOREIGN KEY ("targetId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_diceRollId_fkey" FOREIGN KEY ("diceRollId") REFERENCES "DiceRoll"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReaction" ADD CONSTRAINT "MessageReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomEmoji" ADD CONSTRAINT "CustomEmoji_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceState" ADD CONSTRAINT "VoiceState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceState" ADD CONSTRAINT "VoiceState_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_gmUserId_fkey" FOREIGN KEY ("gmUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_defaultChannelId_fkey" FOREIGN KEY ("defaultChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMember" ADD CONSTRAINT "CampaignMember_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignMember" ADD CONSTRAINT "CampaignMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSession" ADD CONSTRAINT "CampaignSession_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSession" ADD CONSTRAINT "CampaignSession_voiceChannelId_fkey" FOREIGN KEY ("voiceChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSession" ADD CONSTRAINT "CampaignSession_textChannelId_fkey" FOREIGN KEY ("textChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSessionRsvp" ADD CONSTRAINT "CampaignSessionRsvp_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CampaignSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSessionRsvp" ADD CONSTRAINT "CampaignSessionRsvp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNote" ADD CONSTRAINT "CampaignNote_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignNote" ADD CONSTRAINT "CampaignNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handout" ADD CONSTRAINT "Handout_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handout" ADD CONSTRAINT "Handout_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoutVisibleUser" ADD CONSTRAINT "HandoutVisibleUser_handoutId_fkey" FOREIGN KEY ("handoutId") REFERENCES "Handout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoutVisibleUser" ADD CONSTRAINT "HandoutVisibleUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiceRoll" ADD CONSTRAINT "DiceRoll_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiceRoll" ADD CONSTRAINT "DiceRoll_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardGame" ADD CONSTRAINT "BoardGame_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardGame" ADD CONSTRAINT "BoardGame_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNight" ADD CONSTRAINT "GameNight_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNight" ADD CONSTRAINT "GameNight_voiceChannelId_fkey" FOREIGN KEY ("voiceChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNight" ADD CONSTRAINT "GameNight_textChannelId_fkey" FOREIGN KEY ("textChannelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNight" ADD CONSTRAINT "GameNight_selectedBoardGameId_fkey" FOREIGN KEY ("selectedBoardGameId") REFERENCES "BoardGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNight" ADD CONSTRAINT "GameNight_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightCandidate" ADD CONSTRAINT "GameNightCandidate_gameNightId_fkey" FOREIGN KEY ("gameNightId") REFERENCES "GameNight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightCandidate" ADD CONSTRAINT "GameNightCandidate_boardGameId_fkey" FOREIGN KEY ("boardGameId") REFERENCES "BoardGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightCandidate" ADD CONSTRAINT "GameNightCandidate_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightVote" ADD CONSTRAINT "GameNightVote_gameNightId_fkey" FOREIGN KEY ("gameNightId") REFERENCES "GameNight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightVote" ADD CONSTRAINT "GameNightVote_boardGameId_fkey" FOREIGN KEY ("boardGameId") REFERENCES "BoardGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightVote" ADD CONSTRAINT "GameNightVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightRsvp" ADD CONSTRAINT "GameNightRsvp_gameNightId_fkey" FOREIGN KEY ("gameNightId") REFERENCES "GameNight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameNightRsvp" ADD CONSTRAINT "GameNightRsvp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SafetyPolicy" ADD CONSTRAINT "SafetyPolicy_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
