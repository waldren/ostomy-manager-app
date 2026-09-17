-- Default rows for `validation_thresholds`.
--
-- WHY A MIGRATION AND NOT THE SEED GENERATOR
--
-- `packages/seed` is development-only and has no path to a production
-- database (ADR-0009). These two rows are not seed DATA — they are
-- configuration the API cannot start serving without, in EVERY environment.
-- `ThresholdsService.getVolumetricThresholds()` throws when either row is
-- missing, and it sits on the Tier 1/Tier 2 path of every observation write
-- and every synced operation. Seeding them only in development would leave
-- production 500ing on the first clinical write, discovered in production.
--
-- Found exactly that way at the Gate B rehearsal: a freshly migrated database
-- has an empty `validation_thresholds`, so `GET /api/v1/thresholds` was a 500
-- and no write could have succeeded.
--
-- WHY THIS IS NOT "a threshold hardcoded in code"
--
-- CLAUDE.md forbids numeric thresholds as constants in code, and this is the
-- mechanism that rule presupposes: the values live in a table an admin can
-- change (P3.S3's config API, and the console at P8), and the application
-- reads them from there. A migration establishes the DEFAULT once; it is not
-- consulted at runtime and nothing in the application reads these literals.
--
-- ON CONFLICT DO NOTHING is load-bearing for the same reason. Re-running
-- migrations must never reset a value an operator has tuned — a redeploy
-- silently restoring a clinical default an admin deliberately changed is the
-- failure this clause exists to prevent.

-- SRS AC 2.1 AC2 names this one: output above 2,000 mL in a single entry is
-- implausible-but-real and warrants a soft warning. Tier 2 — it asks for
-- confirmation and saves; it is never a block (SRS §3.8), because a real
-- 2,500 mL day is the data point the care team most needs.
--
-- patient_adjustable: TRUE. Per-patient normal output varies enormously with
-- ostomy type and time since surgery, and CLAUDE.md names the heart-rate red
-- flag as "the one threshold that is not patient-adjustable" — which makes
-- every other one adjustable by default.
INSERT INTO validation_thresholds (
  id, threshold_key, tier, value, unit, patient_adjustable, description, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'stoma_output_single_entry_warning_ml',
  'TIER_2_SOFT_WARNING',
  2000.0000,
  'mL',
  TRUE,
  'Single-entry stoma output above this many mL trips a Tier 2 soft warning (SRS AC 2.1 AC2). Overridable by the patient on confirmation; never a hard block.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
) ON CONFLICT (threshold_key) DO NOTHING;

-- docs/sync-contract.md §3.8. NOT a clinical bound: it is what stops a device
-- whose clock is set to 2031 from winning every last-write-wins conflict
-- against every other device, permanently, for every entity it touches.
--
-- 300 seconds is a DEFAULT THIS MIGRATION CHOOSES, not a value the spec
-- states. ADR-0001 point 5 and the implementation plan both call for "a
-- stated default" and neither names one. Five minutes is generous against
-- ordinary phone clock drift while keeping the poisoned-timestamp window
-- short. Tune it in the config table, not here.
--
-- There is deliberately no symmetric PAST bound: a device offline for three
-- weeks legitimately pushes three-week-old timestamps, and that queue is
-- exactly what must not be discarded (§3.8).
--
-- OPERATIONAL, not a validation tier: it bounds a transport-level claim about
-- when a write happened, not the clinical plausibility of what was written.
-- `ThresholdsService` asserts this tier, so changing it here breaks startup
-- rather than silently altering what the value means.
--
-- patient_adjustable: FALSE. Nothing about a patient's clinical situation
-- makes a wider skew allowance appropriate, and a patient who could widen it
-- could make their own device win every conflict.
INSERT INTO validation_thresholds (
  id, threshold_key, tier, value, unit, patient_adjustable, description, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'sync_clock_skew_allowance_seconds',
  'OPERATIONAL',
  300.0000,
  'seconds',
  FALSE,
  'How far into the future a synced operation clientTimestamp may fall before it is rejected with CLIENT_TIMESTAMP_OUT_OF_RANGE (docs/sync-contract.md 3.8). Operational bound, not clinical.',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
) ON CONFLICT (threshold_key) DO NOTHING;
