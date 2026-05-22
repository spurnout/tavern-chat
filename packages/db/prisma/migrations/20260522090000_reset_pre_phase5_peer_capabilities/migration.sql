-- Reset the capabilities column to empty for any peered RemoteInstance rows
-- that were created before capability intersection was enforced (Phase 5).
-- On next contact the peering.accept re-handshake repopulates the column with
-- the correctly-intersected set.  Rows that already carry the full
-- three-capability set ('messages','dms','presence') were peered post-Phase-5
-- and are unaffected.
UPDATE "RemoteInstance"
SET    "capabilities" = ARRAY[]::text[]
WHERE  "status" = 'peered'
AND    NOT (
         'messages' = ANY("capabilities")
         AND 'dms'      = ANY("capabilities")
         AND 'presence' = ANY("capabilities")
       );
