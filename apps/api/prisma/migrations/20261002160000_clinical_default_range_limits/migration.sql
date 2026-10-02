-- Per-range-type bounds and units for clinical_default_ranges (#102).
--
-- `POST`/`PUT /api/v1/admin/default-ranges` validate that a bound is numeric
-- and fits `DECIMAL(12,4)`, and nothing about whether it is sensible for its
-- `range_type`. The consequential case is the one #94 moved into this table:
-- once `heart_rate_red_flag_bpm` is seeded, a low value fires a seek-care
-- prompt on every reading — which SRS §3.8 says "would train patients to
-- dismiss an urgent prompt as another data-entry warning" — and a high value
-- silences it with no symptom at all.
--
-- ## Why this is a separate table and not columns on the row
--
-- #93 solved the same problem for `validation_thresholds` with
-- `min_settable_value`/`max_settable_value` columns on each row, seeded by the
-- same migration that seeds the row. That does not transfer here, and the
-- reason is worth recording so nobody tries it: `validation_thresholds` rows
-- are seeded by migration, while `clinical_default_ranges` is **seeded by
-- nothing** — its rows are created by an admin through the API, which is why
-- that surface has a create at all. Per-row bound columns would therefore be
-- supplied by the very admin they are meant to constrain. Circular, and
-- worthless as a control.
--
-- The TYPE is where the meaning lives: every `heart_rate_red_flag_bpm` row
-- means the same thing regardless of its ostomy type or day window, so the
-- bounds belong to the type.
--
-- ## This also gives #97's leftover rule a home
--
-- #97 made the overlap and ordering invariants database guarantees and left one
-- application-only: rows sharing a `range_type` must agree on their `unit`. It
-- is a cross-row invariant the exclusion constraint cannot partition, and #97
-- said its home was this table. `unit` is NOT NULL here and the admin surface
-- now reads it rather than accepting one, which replaces a cross-row check with
-- a single source of truth — and the units are not a clinical judgement at all,
-- they are derivable from the type name.
CREATE TABLE "clinical_default_range_limits" (
    "range_type" TEXT NOT NULL,

    -- The range a bound on this type may be set within. NOT NULL so a type
    -- added later cannot arrive unbounded — the forcing function #93 chose for
    -- the same reason.
    "min_value" DECIMAL(12,4) NOT NULL,
    "max_value" DECIMAL(12,4) NOT NULL,

    -- The unit every row of this type must carry. Replaces the cross-row
    -- agreement check #97 could not express.
    "unit" TEXT NOT NULL,

    -- Why these numbers are what they are, in the row itself. The admin surface
    -- does not return it; it is for whoever next asks "can I widen this?".
    "basis" TEXT NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinical_default_range_limits_pkey" PRIMARY KEY ("range_type"),
    CONSTRAINT "clinical_default_range_limits_ordered" CHECK ("min_value" < "max_value")
);

-- The runtime role reads these and never writes them: the limits are migration
-- owned, like `tier` on a validation threshold. No UPDATE, no DELETE, no INSERT
-- — which is what makes "immutable through the admin API" structural rather
-- than a convention the service happens to follow.
GRANT SELECT ON "clinical_default_range_limits" TO "ostomy_runtime";

-- ## The bounds, and which of them are decided
--
-- **Decided, and they are engineering rather than clinical judgements:** the
-- sign of each type, and a physical-impossibility ceiling where one exists. A
-- volume cannot be negative, a percentage change cannot exceed 100, and no
-- achievable human heart rate exceeds 300 bpm — above those a value is a typo,
-- not a bound someone chose.
--
-- **Not decided, and left at the column's full width:** the clinically
-- plausible narrowing. #102 stays open for it, and the gap is specific rather
-- than vague, so it is worth stating what is and is not protected:
--
--   For `heart_rate_red_flag_bpm` the 300 bpm ceiling **does** prevent the
--   prompt being silenced, which is one of the two failures #102 names. The
--   floor does **not** prevent it firing on every reading — that needs the
--   lowest resting heart rate at which advising someone to seek care is
--   justified, which is a clinical number and not one an implementer should
--   invent. Half the control, and the half that is missing is named.
--
-- `-1` and `-0.0001` style sentinels are avoided: the full width of the column
-- is `99999999.9999`, and a pair spanning it is the encoding for "no narrower
-- bound decided" — the same convention #93 used, so a reader of either table
-- recognises it.
INSERT INTO "clinical_default_range_limits"
  ("range_type", "min_value", "max_value", "unit", "basis", "updated_at")
VALUES
  -- Volumes. Positive by nature, the same structural rule Tier 1 applies to an
  -- entered volume. Clinical ceilings undecided.
  ('daily_output_ml', 0.0001, 99999999.9999, 'mL',
   'Floor: a volume is positive (structural). Ceiling: UNDECIDED, awaiting a clinical plausible-maximum for daily stoma output.', now()),
  ('urine_output_adequacy_ml', 0.0001, 99999999.9999, 'mL',
   'Floor: a volume is positive (structural). Ceiling: UNDECIDED. Note this type has no clinically meaningful upper bound, so a one-sided range is the normal shape.', now()),

  -- The one type that is legitimately negative: a net balance is intake minus
  -- output, and a deficit is the case the signal exists to detect. Giving this
  -- a positive floor would have been the most plausible-looking mistake here.
  ('net_fluid_balance_ml', -99999999.9999, 99999999.9999, 'mL',
   'Signed by nature: a deficit is a real and clinically important value, so no positive floor. Both bounds UNDECIDED pending clinical plausible limits.', now()),

  -- A percentage of body weight. Above 100 it is not a threshold.
  ('weight_change_threshold_percent', 0.0001, 100.0000, '%',
   'Floor: positive (structural). Ceiling: 100 — a weight change above 100% is physically impossible, so a larger value is a typo. The clinically plausible narrowing (ADR-0005 notes weight is the signal most sensitive to rounding) is UNDECIDED.', now()),

  -- Heart rates. 300 bpm exceeds any achievable human rate including recorded
  -- SVT extremes, so it is an impossibility ceiling rather than a clinical one.
  ('resting_heart_rate_elevation_bpm', 0.0001, 300.0000, 'bpm',
   'Floor: positive (structural). Ceiling: 300 bpm exceeds any achievable human heart rate, so this is a physical-impossibility bound. Clinical narrowing UNDECIDED.', now()),
  ('orthostatic_postural_rise_bpm', 0.0001, 300.0000, 'bpm',
   'Floor: positive (structural). Ceiling: 300 bpm, physical impossibility. Clinical narrowing UNDECIDED.', now()),

  -- The safety bound. The ceiling is doing real work here, which is why it is
  -- the one row whose basis is worth reading in full.
  ('heart_rate_red_flag_bpm', 0.0001, 300.0000, 'bpm',
   'Floor: positive (structural) — this does NOT prevent the prompt firing on every reading, which needs the lowest resting rate at which advising care is justified, a clinical number (#102). Ceiling: 300 bpm, which DOES prevent the prompt being silenced, because no reading can exceed it. Half the control; the missing half is named.', now());

-- ## The foreign key, and what it closes
--
-- `range_type` on `clinical_default_ranges` was free text with a format regex.
-- A typo created a row of a type nothing reads — the hazard
-- `admin-default-range-wire.ts` worries about where it explains why
-- `SAFETY_RANGE_TYPES` is a shared constant rather than a literal retyped out
-- of a schema comment. With this key a typo is refused by the database.
--
-- It also answers #102's open question about adding a new range type: it becomes
-- a migration, which is correct. The types are the shape of the clinical model
-- rather than ordinary configuration, and SRS §3.11 has the console managing the
-- default range *tables*, not inventing new kinds of range.
--
-- `ON DELETE RESTRICT`: a limits row cannot be removed while ranges of that type
-- exist. `ON UPDATE CASCADE` so a future rename of a type stays a single
-- migration rather than an ordering puzzle.
ALTER TABLE "clinical_default_ranges"
  ADD CONSTRAINT "clinical_default_ranges_range_type_fkey"
  FOREIGN KEY ("range_type")
  REFERENCES "clinical_default_range_limits"("range_type")
  ON DELETE RESTRICT ON UPDATE CASCADE;
