-- PermissionOverwrite — drop the hard targetId→Role foreign key.
--
-- `targetId` is a discriminated reference: a Role.id when targetType='role',
-- a User.id when targetType='user'. The old `PermissionOverwrite_role_fkey`
-- FK constrained targetId to Role(id), so every USER overwrite violated it and
-- the upsert 500'd — per-user channel overwrites were broken end-to-end even
-- though the route, enum, and zod schema all advertise them.
--
-- A single column cannot reference two tables, so we drop the FK rather than
-- split the column (which would diverge the row shape from the wire format,
-- which keys on targetType/targetId). ULIDs are never reused, so an overwrite
-- whose target is later deleted is inert; role deletion now clears its
-- overwrites in application code (routes/roles.ts), replacing the FK cascade.

ALTER TABLE "PermissionOverwrite" DROP CONSTRAINT IF EXISTS "PermissionOverwrite_role_fkey";
