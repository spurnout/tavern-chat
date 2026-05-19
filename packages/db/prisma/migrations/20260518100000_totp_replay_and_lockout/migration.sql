-- TOTP hardening: replay protection + lockout (security review 2026-05-18).
--
-- `totpLastCounter` is the highest TOTP counter (floor(unix_seconds / 30) + window)
-- that this account has already accepted. The verifier rejects any matched
-- counter <= this value, closing the replay window between the 30-second TOTP
-- slot tick and the staged-token's TTL.
--
-- `failedTotpAttempts` and `totpLockedUntil` mirror the existing
-- failedLoginAttempts / loginLockedUntil pair so the TOTP step also locks
-- after too many bad codes — symmetric with the password step.

ALTER TABLE "User"
    ADD COLUMN "totpLastCounter" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "failedTotpAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "totpLockedUntil" TIMESTAMP(3);
