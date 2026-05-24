-- Additive index for User.remoteInstanceId. The relation has existed since
-- the federation phase 2 migration (Wave 4), but the foreign-key column
-- had no index — peer revocation and "list all users from instance X"
-- queries did a sequential scan on the User table (potentially huge as
-- federation grows). RemoteUser already has the symmetric @@index; this
-- catches the User-side gap.

CREATE INDEX IF NOT EXISTS "User_remoteInstanceId_idx"
  ON "User" ("remoteInstanceId");
