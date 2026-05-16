-- Rich profile fields surfaced by the member profile card.
-- All additive: existing rows get NULL for the new columns and an empty
-- jsonb array for socialLinks.
ALTER TABLE "User"
  ADD COLUMN "pronouns" VARCHAR(32),
  ADD COLUMN "accentColor" VARCHAR(7),
  ADD COLUMN "timezone" VARCHAR(64),
  ADD COLUMN "customStatus" VARCHAR(128),
  ADD COLUMN "socialLinks" JSONB NOT NULL DEFAULT '[]'::jsonb;
