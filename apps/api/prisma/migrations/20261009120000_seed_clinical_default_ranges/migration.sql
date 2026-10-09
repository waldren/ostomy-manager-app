-- P4.S2 slice 1 — the clinical defaults §3.9 seeds suggestions from.
--
-- `clinical_default_range_limits` has defined these three range types since
-- #102, and `clinical_default_ranges` has held exactly two rows the whole time:
-- the heart-rate safety bounds. So "Initial suggestions come from admin-managed
-- default range tables keyed to ostomy type and time since surgery, so there is
-- useful guidance from day one" (SRS §3.9) had nothing to read.
--
-- ============================================================================
-- THESE NUMBERS ARE IMPLEMENTER-CHOSEN AND HAVE NOT BEEN RATIFIED BY A
-- CLINICIAN.
-- ============================================================================
--
-- The same standing as the 120 bpm heart-rate bound (#102), and recorded the
-- same way: defensible starting values, stated as such, with an integration
-- test pinning every one of them so ratification is a visible change to this
-- repository rather than an edit nobody notices. Ratifying a value is an
-- ordinary migration; changing one quietly is what the test prevents.
--
-- They are drawn from the ranges ostomy literature and patient-education
-- material commonly cite. They are NOT a treatment recommendation, and SRS
-- §3.9's framing constraint carries that into the copy: a suggestion is
-- described as what is typical for a similar profile, never as advice.
--
-- ## Why a migration rather than `packages/seed`
--
-- The same reason `validation_thresholds` is seeded by one (CLAUDE.md): these
-- are configuration every environment needs, not development data. A patient
-- onboarding into production must meet a suggestion on day one, and a dev-only
-- seed would leave production with none.
--
-- `ON CONFLICT DO NOTHING`, so a redeploy never resets a value an admin tuned —
-- and note what that means here: once the console exists, ratified numbers
-- replace these through the admin surface, and re-running this migration must
-- not undo that.
--
-- ## The windows
--
-- Three for stoma output, because output is highest soon after surgery and
-- settles over roughly three months — which is the whole reason §3.9 keys on
-- "time since surgery" and not on ostomy type alone. Contiguous and
-- non-overlapping: 0-30, 31-90, 91 onward. #97's `EXCLUDE USING gist`
-- constraint refuses an overlap at the database level, so this is checked
-- rather than merely intended.
--
-- One window each for urine adequacy and net fluid balance, because neither
-- target is a function of how long ago the surgery was.

-- ---------------------------------------------------------------------------
-- daily_output_ml — total stoma output over a patient-local day.
--
-- An ileostomy drains liquid effluent before the colon has absorbed water, so
-- its volumes are roughly three times a colostomy's. That ratio is the reason
-- `clinical_default_ranges` is keyed on `ostomy_type` at all, and
-- `colostomy-baseline` exists in `packages/seed` to demonstrate it.
--
-- The high bound is NOT the >2,000 mL Tier 2 warning: that is a data-quality
-- bound on a single entry, admin-managed in `validation_thresholds`. This is a
-- daily total, and above it the day is unusual for this patient's profile
-- rather than implausible as a reading.
-- ---------------------------------------------------------------------------
INSERT INTO "clinical_default_ranges"
  ("id", "ostomy_type", "range_type", "min_days_post_op", "max_days_post_op",
   "low_value", "high_value", "unit", "window_days", "created_at", "updated_at")
VALUES
  -- Early: output has not yet settled and runs higher.
  (gen_random_uuid(), 'ILEOSTOMY', 'daily_output_ml',  0,  30,  600.0000, 1500.0000, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'ILEOSTOMY', 'daily_output_ml', 31,  90,  500.0000, 1200.0000, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'ILEOSTOMY', 'daily_output_ml', 91, NULL, 500.0000, 1000.0000, 'mL', NULL, now(), now()),

  (gen_random_uuid(), 'COLOSTOMY', 'daily_output_ml',  0,  30,  300.0000,  800.0000, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'COLOSTOMY', 'daily_output_ml', 31,  90,  200.0000,  600.0000, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'COLOSTOMY', 'daily_output_ml', 91, NULL, 200.0000,  500.0000, 'mL', NULL, now(), now())
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- urine_output_adequacy_ml — a FLOOR, so no high bound.
--
-- `high_value` is NULL deliberately, and #97's CHECK permits that (it refuses
-- only a row with NEITHER bound). Passing a lot of urine is not the concern
-- this signal exists for; passing too little is. §3.7 keeps urine out of the
-- fluid balance for precisely that reason — it independently signals renal
-- perfusion, and a reassuring balance can hide a dangerously low output.
--
-- The SAME value for both ostomy types, which is a choice worth stating rather
-- than leaving to look like an oversight: the target is renal perfusion, which
-- is not a function of where the stoma is. An ileostomy patient's higher
-- dehydration risk shows up in their stoma losses, and `daily_output_ml` above
-- is where that is already captured. Two rows rather than one because
-- `ostomy_type` is NOT NULL.
-- ---------------------------------------------------------------------------
INSERT INTO "clinical_default_ranges"
  ("id", "ostomy_type", "range_type", "min_days_post_op", "max_days_post_op",
   "low_value", "high_value", "unit", "window_days", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'ILEOSTOMY', 'urine_output_adequacy_ml', 0, NULL, 1000.0000, NULL, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'COLOSTOMY', 'urine_output_adequacy_ml', 0, NULL, 1000.0000, NULL, 'mL', NULL, now(), now())
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- net_fluid_balance_ml — intake minus stoma output, urine excluded (§3.7).
--
-- A floor again, and the arithmetic is why: whatever this balance leaves has to
-- cover urine output and insensible losses, both of which come out of the same
-- intake. A patient meeting the 1,000 mL urine floor above, plus ordinary
-- insensible losses, needs the balance to be positive by more than the urine
-- figure alone — so the floor sits above it rather than at zero.
--
-- A balance of zero is NOT the target, and a floor of zero would say it was.
-- That is the specific way this bound could be wrong in the dangerous
-- direction: a patient whose intake merely matches their stoma output is
-- dehydrating, and a range that called that adequate would suppress the flag
-- meant to catch it.
--
-- Signed by nature, which is why the limits row for this type permits negative
-- values where the two above do not.
-- ---------------------------------------------------------------------------
INSERT INTO "clinical_default_ranges"
  ("id", "ostomy_type", "range_type", "min_days_post_op", "max_days_post_op",
   "low_value", "high_value", "unit", "window_days", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'ILEOSTOMY', 'net_fluid_balance_ml', 0, NULL, 1500.0000, NULL, 'mL', NULL, now(), now()),
  (gen_random_uuid(), 'COLOSTOMY', 'net_fluid_balance_ml', 0, NULL, 1500.0000, NULL, 'mL', NULL, now(), now())
ON CONFLICT DO NOTHING;
