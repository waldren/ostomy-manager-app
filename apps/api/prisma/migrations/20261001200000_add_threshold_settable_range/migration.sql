-- Per-key settable range for validation_thresholds (#93).
--
-- `PUT /api/v1/admin/thresholds/:key` validated the SHAPE of a value — positive,
-- fits DECIMAL(12,4) — and nothing about whether it was sensible for the key it
-- was written to. Values that passed every rule:
--
--   sync_clock_skew_allowance_seconds = 1
--     A one-second allowance Tier-1 blocks queued entries from most devices,
--     each landing in a correction inbox describing a problem the patient
--     cannot fix. ADR-0019 calls this "the expensive direction".
--
--   stoma_output_single_entry_warning_ml = 20
--     Warns on essentially every entry, which is the failure mode that teaches
--     patients to dismiss warnings — the thing SRS §3.8 is most concerned to
--     avoid.
--
-- #93 weighed two designs. These columns were chosen over a per-key registry in
-- TypeScript for one decisive reason: ADR-0008 builds this surface at final
-- shape so that P8 adds a CLIENT rather than rewriting the API, and a compiled
-- constant cannot later be exposed — to a higher-privileged admin, or behind
-- two-person approval — without being moved here anyway. A settable range is
-- also a different kind of fact from `thresholds.service.ts`'s
-- `expectedUnit`/`expectedTier`, which exist because that service's arithmetic
-- breaks without them: at 20 mL the code works perfectly and warns on
-- everything, so nothing is uninterpretable, the value is just wrong.
--
-- Honest limit, recorded so nobody cites this as satisfying SRS §3.8: changing a
-- limit here is still a migration, so it still requires a deploy. §3.8's
-- "clinical tuning does not require a deploy" is not met by this, and was not
-- met by the alternative either. What this buys is that it CAN be met later
-- without moving the data.

-- NOT NULL on a populated table, so a default carries the existing rows and is
-- then dropped: with no default, a future INSERT cannot create a threshold row
-- without stating its bounds. That forcing function is the whole reason these
-- are NOT NULL rather than nullable. A nullable pair would leave any key added
-- after today silently unbounded, with nothing detecting it — which is the
-- failure class #93 exists to close, left open for every future key.
--
-- The default is the full width of the column, i.e. "no narrower bound has been
-- decided", which is exactly the pre-migration state and therefore cannot
-- change the behaviour of an existing row.
ALTER TABLE "validation_thresholds"
  ADD COLUMN "min_settable_value" DECIMAL(12,4) NOT NULL DEFAULT 0.0001,
  ADD COLUMN "max_settable_value" DECIMAL(12,4) NOT NULL DEFAULT 99999999.9999;

-- One consequence of dropping the defaults that is not obvious and bit three
-- integration specs immediately: Postgres enforces `NOT NULL` on the **proposed**
-- insert tuple, before `ON CONFLICT` is resolved. So an upsert that only ever
-- takes the `DO UPDATE` branch — the shape every fixture here uses to set a
-- threshold value over the seeded one — still fails unless it names these two
-- columns. Any future upsert against this table must list them.
--
-- Keeping a default would have avoided that and defeated the point: an INSERT
-- that omitted the bounds would silently get the full column width, which is
-- "unbounded", which is the failure class #93 exists to close.
ALTER TABLE "validation_thresholds"
  ALTER COLUMN "min_settable_value" DROP DEFAULT,
  ALTER COLUMN "max_settable_value" DROP DEFAULT;

-- sync_clock_skew_allowance_seconds: 60 to 3600.
--
-- Operational, not clinical, and ADR-0019 already reasoned about both
-- directions, so this pair is an engineering judgement rather than a deferred
-- decision.
--
-- Below a minute starts rejecting ordinary phone clock drift, and ADR-0019 asks
-- for an allowance "generous enough that it fires only on genuinely broken
-- clocks" precisely because a rejection here is a Tier 1 hard block the patient
-- has no way to act on — the entry form has no clock field.
--
-- Above an hour, the window in which a device with a badly wrong clock wins
-- every last-write-wins conflict against every other device gets large, which
-- is the hazard the row's own seeding comment describes. The seeded value stays
-- 300 (five minutes).
UPDATE "validation_thresholds"
   SET "min_settable_value" = 60.0000,
       "max_settable_value" = 3600.0000
 WHERE "threshold_key" = 'sync_clock_skew_allowance_seconds';

-- stoma_output_single_entry_warning_ml: DELIBERATELY LEFT UNDECIDED.
--
-- Grep marker: UNDECIDED_SETTABLE_RANGE
--
-- This row keeps the full-column-width range, which means the API constrains it
-- exactly as much as it did before this migration — no more, no less. That is
-- not an oversight and it is not a chosen number: it is a genuine clinical
-- judgement that has not been made, and inventing one here would be the same
-- mistake as a hardcoded threshold, one layer out.
--
-- The question a clinician has to answer, from #93: below what single-entry
-- value would a Tier 2 warning fire so often that it trains patients to dismiss
-- warnings, and above what value would it never usefully fire at all? SRS
-- AC 2.1 AC2 fixes the DEFAULT at 2,000 mL and says nothing about a range.
--
-- #93 stays open for exactly that pair. Narrowing it later is a one-line
-- `UPDATE` in a new migration — not an edit to this file, which Prisma
-- checksums and `migrate deploy` would then refuse.

-- The invariants, enforced by the database and not only by the API.
--
-- Worth having even though the service checks first: unlike
-- `clinical_default_ranges`, whose overlap and unit rules are application-only
-- (#97), a migration, a seeder or a psql session cannot put THIS table into a
-- state the API would refuse.
--
-- The service must still validate before writing, so an out-of-range edit
-- answers a 400 naming the field rather than surfacing as a Prisma error and an
-- opaque 500 — the defect P3.S3 PR A fixed for the DECIMAL(12,4) bounds. These
-- constraints are the backstop, not the interface.
ALTER TABLE "validation_thresholds"
  ADD CONSTRAINT "validation_thresholds_settable_range_ordered"
    CHECK ("min_settable_value" < "max_settable_value");

-- A row may not sit outside its own bounds. This also means a later migration
-- that narrows a range below its current value fails loudly instead of leaving
-- the row illegal — which is intended: it forces the value and its bounds to be
-- decided together.
ALTER TABLE "validation_thresholds"
  ADD CONSTRAINT "validation_thresholds_value_within_settable_range"
    CHECK ("value" BETWEEN "min_settable_value" AND "max_settable_value");
