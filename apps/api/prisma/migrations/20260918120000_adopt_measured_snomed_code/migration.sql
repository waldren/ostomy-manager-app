-- Backfills `observations.method` with SNOMED CT 258104002 |Measured
-- (qualifier value)| for every volumetric entry that was stored as NULL.
--
-- WHY
--
-- Until now `method: NULL` meant two different things: "the patient answered
-- Measured", and "this observation has no Measured/Estimated toggle at all"
-- (weight, resting heart rate). The only way to tell them apart was to know
-- which LOINC codes are volumetric and check `code` — a rule that lived in
-- application code and in no reader's hands. ADR-0018, amended, adopts the
-- paired qualifier so a row states how its number was arrived at instead of
-- implying it by absence. After this, NULL means only "the toggle does not
-- apply".
--
-- WHY THIS IS SCOPED BY `code` AND NOT `WHERE method IS NULL`
--
-- Today every code the API accepts is volumetric
-- (`ACCEPTED_OBSERVATION_CODES` in apps/api/src/observations/
-- observation-wire.ts holds only stoma output and fluid intake), so an
-- unscoped UPDATE would happen to be correct right now. It would stop being
-- correct the moment weight (LOINC 29463-7) or resting heart rate (8867-4)
-- lands in P5-P7 and this migration is re-run against a restored older
-- database, or copied as a template — and the damage is an assertion that a
-- patient chose "Measured" for a number they read off a scale, which they
-- never did and which nothing downstream could distinguish from a real
-- answer. The `code` list is the whole safety property of this migration.
--
-- WHY IT IS SAFE TO RUN AGAINST AN ALREADY-MIGRATED DATABASE
--
-- `method IS NULL` is the guard. A row already carrying 258104002 or
-- 414135002 is not matched, so re-running is a no-op rather than an
-- overwrite. That matters because docs/deployment-development.md requires
-- re-applying migrations to a non-empty database to be a clean no-op.
--
-- WHAT THIS CANNOT DO
--
-- Nothing here can recover a row whose toggle was recorded wrongly before
-- ADR-0018 resolved. It cannot have happened: an estimated entry was refused
-- outright while the code was unresolved (`PAYLOAD_FIELD_INVALID`), so every
-- NULL on a volumetric row is a genuine Measured answer. That is the fact
-- that makes this backfill sound rather than a guess, and it stops being
-- true for any row written after this migration.

UPDATE observations
   SET method = '258104002'
 WHERE method IS NULL
   AND code IN (
     '79560-9',  -- Stoma output volume
     '9000-1'    -- Oral fluid intake volume
   );
