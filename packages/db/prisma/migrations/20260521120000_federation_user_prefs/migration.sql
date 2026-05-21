-- Federation polish (post-Phase 6): per-user opt-outs for federated DMs and
-- presence. See docs/federation-followups.md (#28, #33) and the federation
-- polish plan for design notes.
--
-- Defaults are `true` so existing users keep their pre-migration behaviour
-- (which had no opt-out — they were implicitly opted in). Operators who want
-- to mass-flip retroactively can do so via a one-shot runbook UPDATE.
--
-- Additions:
--   1. User.acceptsFederatedDms       — refuse new inbound federated DMs
--   2. User.acceptsFederatedPresence  — refuse outbound federated presence

-- AlterTable: User — per-user federation prefs
ALTER TABLE "User" ADD COLUMN "acceptsFederatedDms" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "acceptsFederatedPresence" BOOLEAN NOT NULL DEFAULT true;
