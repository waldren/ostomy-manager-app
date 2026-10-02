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

  -- A percentage of body weight, SIGNED — and the first version of this row got
  -- that wrong in the direction that matters. It set a positive floor, which
  -- made the weight-LOSS half unconfigurable: `{lowValue: -3, highValue: 3}` was
  -- refused. SRS §3.12's signal is percent change over a rolling window and the
  -- clinically important direction is a drop, so that removed the dehydration
  -- half of a hydration signal. `admin-default-range-wire.ts` says in terms that
  -- this type "legitimately ha[s] negative floors" — the migration contradicted
  -- code in the same sprint, and the test pinning that comment is schema-only so
  -- it stayed green.
  --
  -- 100 in both directions is the physical bound: you cannot lose more than 100%
  -- of your weight, and a gain above 100% over a window of at most a year is
  -- likewise impossible.
  ('weight_change_threshold_percent', -100.0000, 100.0000, '%',
   'Signed: SRS §3.12 measures percent change in either direction and the clinically important one is a drop. Bounds are the physical limit (±100%), not a clinical plausibility range, which is UNDECIDED.', now()),

  -- Heart rates. 300 bpm exceeds any achievable human rate including recorded
  -- SVT extremes, so it is an impossibility ceiling rather than a clinical one.
  ('resting_heart_rate_elevation_bpm', 0.0001, 300.0000, 'bpm',
   'Floor: positive (structural). Ceiling: 300 bpm exceeds any achievable human heart rate, so this is a physical-impossibility bound. Clinical narrowing UNDECIDED.', now()),
  ('orthostatic_postural_rise_bpm', 0.0001, 300.0000, 'bpm',
   'Floor: positive (structural). Ceiling: 300 bpm, physical impossibility. Clinical narrowing UNDECIDED.', now()),

  -- The safety bound.
  --
  -- The first version of this row claimed the 300 bpm ceiling "DOES prevent the
  -- prompt being silenced, because no reading can exceed it". Both reviews
  -- pointed out that the argument refutes itself: if no reading can exceed 300,
  -- then a threshold OF 300 is one no reading can exceed, so setting it there
  -- silences the prompt completely. The comparison is exclusive, so 300 is
  -- accepted exactly, and in practice anything from roughly 220 upward is
  -- equally silencing. These bounds are a TYPO GUARD and nothing more — both
  -- halves of the clinically meaningful narrowing are undecided, not one.
  --
  -- What actually keeps the prompt reachable is structural and sits elsewhere:
  -- the two rows seeded below, which exist in every environment, plus the
  -- service refusing to create, delete, or un-ceiling a safety row. #102 stays
  -- open for the clinical bound.
  ('heart_rate_red_flag_bpm', 0.0001, 300.0000, 'bpm',
   'TYPO GUARD ONLY. Both halves of the clinical narrowing are UNDECIDED (#102): the floor does not stop the prompt firing on every reading, and the ceiling does not stop it being silenced — a threshold of 300 bpm is one no reading reaches. What keeps the prompt reachable is the seeded rows and the service rules, not these numbers.', now());

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
-- exist.
--
-- `ON UPDATE RESTRICT`, not CASCADE, and the first version had it wrong. A
-- cascade would let a migration rename a limits row and silently rewrite what
-- every existing configuration row MEANS, with no audit row anywhere — and for
-- `heart_rate_red_flag_bpm` it would carry those rows out of
-- `SAFETY_RANGE_TYPES`, which matches a string, so they would become deletable
-- again. CLAUDE.md's precedent is explicit for the analogous case: of
-- `ESTIMATION_METHOD_CODE`, "Changing either is a data migration, not an edit."
-- RESTRICT forces a rename to be written as the data migration it is.
-- Refuse with an actionable message rather than a raw constraint violation.
--
-- `ADD CONSTRAINT ... FOREIGN KEY` validates existing rows, so on any database
-- holding a `clinical_default_ranges` row whose type has no limits row,
-- `migrate deploy` aborts naming no remedy and Prisma marks the migration
-- failed. "The dev database had none" is not evidence: this surface has had a
-- working POST since P3.S3 PR C, and the typo row this migration exists to
-- prevent (`heart_rate_redflag_bpm`) is exactly the row that would block it.
--
-- Deliberately NOT a backfill. Inserting a full-width limits row for an unknown
-- type would be the control switching itself off to get past its own check.
DO $$
DECLARE orphans TEXT;
BEGIN
  SELECT string_agg(DISTINCT r.range_type, ', ') INTO orphans
    FROM clinical_default_ranges r
    LEFT JOIN clinical_default_range_limits l ON l.range_type = r.range_type
   WHERE l.range_type IS NULL;
  IF orphans IS NOT NULL THEN
    RAISE EXCEPTION
      'clinical_default_ranges holds range_type(s) with no limits row: %. Remove those rows, or add limits rows for them in a migration ordered before this one. A full-width limits row is not an acceptable fix - it defeats the bound it would be added to satisfy.',
      orphans;
  END IF;
END $$;

ALTER TABLE "clinical_default_ranges"
  ADD CONSTRAINT "clinical_default_ranges_range_type_fkey"
  FOREIGN KEY ("range_type")
  REFERENCES "clinical_default_range_limits"("range_type")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## The safety rows, seeded — which is what makes any of the above matter
--
-- Review found the hole that subsumes the others: **nothing seeded a red-flag
-- row.** `heart_rate_red_flag_bpm` appeared in this table, in the schema
-- comments, in the wire module and in the tests, and in no seeder — so the
-- shipping state of every environment was "no red-flag threshold for any
-- patient", which is the silenced configuration, and #98's delete guard was
-- protecting a row that did not exist.
--
-- Seeded here rather than left to the admin surface because SRS §3.9 calls this
-- "a **fixed** clinical safety bound managed in Section 3.11", and because the
-- service now refuses to create one: if removing a safety row is too dangerous
-- for that surface, so is creating one with the wrong window or the wrong
-- rolling-window shape. `validation_thresholds` is the precedent — configuration
-- every environment needs is seeded by migration, with `ON CONFLICT DO NOTHING`
-- so a redeploy never resets a value an admin tuned.
--
-- **Two rows, because `ostomy_type` is NOT NULL.** The bound is population-wide
-- and both rows carry the same value; the duplication is a schema artefact, not
-- a clinical distinction. #98 is specifically about the asymmetry one row going
-- missing would create, which seeding both at once is what prevents.
--
-- Day 0 to unbounded, no rolling window: the window is the whole population for
-- all time, which is the claim the service's own comments make and that nothing
-- previously enforced.
--
-- `low_value` is NULL because the spec is directional. SRS §3.13: "a reading
-- **beyond** a configured red-flag threshold"; AC at SRS line 784: "a heart-rate
-- reading **exceeds** the configured red-flag threshold". A lower bound would be
-- a different clinical claim, and the service refuses one on this type.
--
-- ### 120 bpm, and its standing
--
-- **Chosen by an implementer and not ratified by a clinician**, the same footing
-- as #93's stoma-output pair, and the reasoning is the thing to audit:
--
-- Resting tachycardia is conventionally above 100 bpm, and tachycardia is an
-- early compensatory sign of the hypovolaemia a high-output stoma causes — which
-- is why §3.13 exists. But a seek-care prompt has to be RARE to mean anything:
-- SRS §3.8 is explicit that conflating an urgent prompt with routine warnings
-- "would train patients to dismiss an urgent prompt", and a resting rate above
-- 100 is reachable by caffeine, anxiety, deconditioning or a mild fever in
-- people who need no care. 120 bpm at rest is clearly abnormal and is not
-- ordinarily reached by those causes.
--
-- §3.13's resting-condition prompt and its exclusion of non-resting readings
-- from the baseline are what make a bound at rest meaningful at all; this bound
-- is evaluated against a reading, not against the baseline.
--
-- Changing it is a `PUT` — the one mutation this surface still allows on a
-- safety row — so ratification needs no migration. An integration test pins
-- 120, so a clinician's decision cannot land silently.
INSERT INTO "clinical_default_ranges"
  ("id", "ostomy_type", "range_type", "min_days_post_op", "max_days_post_op",
   "low_value", "high_value", "unit", "window_days", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'ILEOSTOMY', 'heart_rate_red_flag_bpm', 0, NULL,
   NULL, 120.0000, 'bpm', NULL, now(), now()),
  (gen_random_uuid(), 'COLOSTOMY', 'heart_rate_red_flag_bpm', 0, NULL,
   NULL, 120.0000, 'bpm', NULL, now(), now())
ON CONFLICT DO NOTHING;
