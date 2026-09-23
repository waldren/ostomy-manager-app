-- P3.S2: voided urine (SRS §3.7, AC 12.1).
--
-- Voided urine shares the `observations` table, distinguished by its LOINC
-- code (9187-6) — it is NOT a separate table. That is a standing rule in
-- CLAUDE.md, and it is why this migration widens the existing table rather
-- than adding one.
--
-- It is also the first entry type that may carry NO VOLUME. AC 12.1 AC2:
-- a patient who cannot measure may save a colour alone, and the entry is
-- retained as a valid hydration observation. That is the whole point of
-- the feature — the patients least able to measure are the ones whose
-- hydration signal matters most.
--
-- ## Why `value_quantity_value` becomes nullable, and what stops that
-- ## becoming a hole
--
-- A nullable clinical value is exactly the kind of change that silently
-- corrupts a total: `SUM()` skips NULL, but application code that treats a
-- missing value as 0 does not, and the two disagree forever afterwards.
-- The constraints below therefore keep the structural invariant in the
-- DATABASE rather than in whichever read path remembers it — the same
-- choice ADR-0011 makes for audit immutability (a grant, not a convention)
-- and ADR-0012 makes for entered_measurement_system (NOT NULL with no
-- default, so a write cannot omit it).
--
-- What is deliberately NOT expressed as a constraint: "which codes are
-- volumetric". That list lives once, in `observation-wire.ts`'s accepted-code
-- table, and grows every time a code is added (weight at P6, heart rate at
-- P7). Encoding it in SQL too would duplicate a growing list in a second
-- place and guarantee drift. The database enforces what is true of every
-- code forever; the application enforces what is true of this release's set.

ALTER TABLE "observations" ALTER COLUMN "value_quantity_value" DROP NOT NULL;
ALTER TABLE "observations" ALTER COLUMN "value_quantity_unit" DROP NOT NULL;

-- The coded colour, when one was chosen. Nullable: a urine entry may carry a
-- volume, a colour, or both.
--
-- An app-native value set (`urine_color` below), not a standard terminology.
-- A pale-to-dark hydration chart is a patient-facing proxy rather than a
-- standard lab observation, and this repo already carries app-native coded
-- sets for exactly that kind of thing (`fluid_type`, `meal_tag`). The trade
-- is the same one `Observation.fluidTypeCode` makes and is recorded there:
-- no referential integrity to `value_set_members`, because members are
-- retired and never deleted, so a stored code always resolves.
ALTER TABLE "observations" ADD COLUMN "urine_color_code" TEXT;

-- 1. A volume and its unit travel together, in both directions.
--
-- Without this, dropping NOT NULL above would permit a row with a unit and
-- no value (a total that silently contributes nothing) or a value with no
-- unit (FHIR `valueQuantity` requires one, so the export would be invalid).
ALTER TABLE "observations" ADD CONSTRAINT "observations_volume_with_unit"
  CHECK (("value_quantity_value" IS NULL) = ("value_quantity_unit" IS NULL));

-- 2. Only voided urine may omit the volume, and only when it carries a
--    colour instead.
--
-- This is AC 12.1 AC2 expressed where it cannot be forgotten. An entry with
-- neither a volume nor a colour records nothing at all, and a stoma output
-- row with no volume is the defect this constraint exists to make
-- unwritable.
ALTER TABLE "observations" ADD CONSTRAINT "observations_value_or_urine_color"
  CHECK (
    "value_quantity_value" IS NOT NULL
    OR ("code" = '9187-6' AND "urine_color_code" IS NOT NULL)
  );

-- 3. A colour belongs only to voided urine.
--
-- Nothing else in this system has one, and a colour landing on a stoma
-- output row would render as a hydration signal for the wrong observation.
ALTER TABLE "observations" ADD CONSTRAINT "observations_urine_color_only_on_urine"
  CHECK ("urine_color_code" IS NULL OR "code" = '9187-6');

-- 4. No Measured/Estimated qualifier without a volume to qualify.
--
-- ADR-0018 (amended) fixed `method` at rest to mean exactly one thing when
-- null: "this observation has no toggle". Colour-only urine joins weight and
-- resting heart rate in that set — it has no volume, so there is nothing for
-- Measured/Estimated to describe, and a qualifier on it would assert
-- something about a number that does not exist.
--
-- The converse — volumetric codes REQUIRE a method — stays in application
-- validation for the reason given at the top: it depends on the accepted-code
-- table, which grows.
ALTER TABLE "observations" ADD CONSTRAINT "observations_method_needs_a_value"
  CHECK ("method" IS NULL OR "value_quantity_value" IS NOT NULL);

-- The colour scale.
--
-- Seeded by MIGRATION, not by packages/seed, for the same reason the
-- validation thresholds are: these are configuration every environment
-- needs, not development data. A dev-only seed would leave the urine screen
-- rendering an empty scale in production.
--
-- `ON CONFLICT DO NOTHING` throughout, so a redeploy never resurrects a
-- member an admin retired (CLAUDE.md: value-set members are retired, never
-- deleted, and neither an admin action nor a deploy may change what a past
-- entry means).
INSERT INTO "value_sets" ("id", "key", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'urine_color', 'Pale-to-dark urine colour scale offered when logging voided urine (SRS §3.7, AC 12.1 AC2). Optional on an entry, and the only field a colour-without-volume entry carries.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Member CODES are stable identifiers, never display text — the label a
-- patient reads comes from the i18n catalog in packages/core, so there is one
-- localization pipeline rather than two. Every code below needs a matching
-- catalog key before the screen can render it.
--
-- `sort_order` is the clinical ordering, pale to dark, and it is meaningful
-- here in a way it is not for `fluid_type`: the scale IS an ordering, and a
-- screen that rendered it out of sequence would misrepresent the signal.
-- Numbered in tens so a future step can be inserted between two without
-- renumbering rows that history already references.
INSERT INTO "value_set_members" ("id", "value_set_id", "code", "status", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), vs."id", m."code", 'ACTIVE', m."sort_order", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "value_sets" vs
CROSS JOIN (VALUES
  ('pale_straw', 10),
  ('straw', 20),
  ('yellow', 30),
  ('dark_yellow', 40),
  ('amber', 50),
  ('brown', 60)
) AS m("code", "sort_order")
WHERE vs."key" = 'urine_color'
ON CONFLICT ("value_set_id", "code") DO NOTHING;
