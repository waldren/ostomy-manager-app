-- Database-level invariants for clinical_default_ranges (#97).
--
-- `AdminDefaultRangesService` refuses overlapping day windows, a row with
-- neither bound, inverted bounds, an inverted window, and siblings disagreeing
-- on a unit. The table enforced **none** of it, so a migration, `packages/seed`
-- or a psql session could create any state the API refuses. CLAUDE.md said so
-- in terms — "Do not read 'overlap is refused' as a database guarantee" — and
-- this migration is what lets that sentence be deleted.
--
-- ## The state that was invisible, not merely reachable
--
-- `windowsOverlap` compares `aStart <= bEnd && bStart <= aEnd`. For an
-- **inverted** row (min > max) that is false against everything, so such a row
-- is permanently invisible to the overlap check and every later create silently
-- succeeds against it. The wire schema refuses to create one, which is exactly
-- why nobody would notice the hole: it can only arrive by another route, and
-- once it has, the API's own rule stops working with no symptom. The
-- `window_ordered` CHECK below makes that row unrepresentable, which retires
-- the blind spot rather than teaching the comparison about it.
--
-- ## Three things about the exclusion constraint
--
-- **`btree_gist` is required** for the equality parts, and is `trusted` from
-- PG 13 — verified on this stack (17.11, btree_gist 1.7, `trusted = t`), so the
-- non-superuser owner role can create it. **Confirm it on the RDS parameter
-- group before staging**: a trusted extension still has to be in
-- `rds.allowed_extensions`, and a migration that cannot run is worse than one
-- that was never written.
--
-- **`int4range` is half-open; these windows are inclusive at both ends.** Hence
-- `max_days_post_op + 1`. Getting that wrong reintroduces precisely the
-- one-day overlap the API rule exists to catch — days 0-30 and 31-60 must not
-- collide, days 0-30 and 30-60 must.
--
-- A NULL `max_days_post_op` means "onward", so the upper bound stays NULL,
-- which `int4range` reads as unbounded. A NULL `min_days_post_op` means "from
-- surgery", i.e. day 0, which is why it is coalesced rather than left unbounded
-- downward.
--
-- **`window_days` is coalesced, and that is the decision #97 asked for.**
-- Postgres treats `NULL = NULL` as unknown, so a bare `window_days WITH =`
-- would let two rolling-window-less rules overlap in one window — while the
-- service compares `sibling.windowDays === candidate.windowDays` in JavaScript,
-- where `null === null` is TRUE and the same pair is refused. A constraint whose
-- whole job is to make the API's rule undodgeable must not be laxer than the
-- API, and the null case is the common one: most rules carry no rolling window.
-- `-1` is safe as the sentinel because `window_days` is a positive day count.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "clinical_default_ranges"
  ADD CONSTRAINT "clinical_default_ranges_window_no_overlap"
  EXCLUDE USING gist (
    "ostomy_type" WITH =,
    "range_type" WITH =,
    COALESCE("window_days", -1) WITH =,
    int4range(
      COALESCE("min_days_post_op", 0),
      CASE WHEN "max_days_post_op" IS NULL THEN NULL ELSE "max_days_post_op" + 1 END
    ) WITH &&
  );

-- The three the wire schema already asserts, so the two agree rather than the
-- API being the only thing that knows.
--
-- `window_ordered` is the one that retires the invisible-row hazard above. The
-- other two protect a reader rather than the overlap check: a row with no bound
-- at all seeds nothing, and an inverted pair would seed a range no value can
-- satisfy — §3.9's consumer would treat every reading as out of range.
ALTER TABLE "clinical_default_ranges"
  ADD CONSTRAINT "clinical_default_ranges_window_ordered"
    CHECK (
      "min_days_post_op" IS NULL
      OR "max_days_post_op" IS NULL
      OR "min_days_post_op" <= "max_days_post_op"
    ),
  ADD CONSTRAINT "clinical_default_ranges_has_a_bound"
    CHECK ("low_value" IS NOT NULL OR "high_value" IS NOT NULL),
  ADD CONSTRAINT "clinical_default_ranges_bounds_ordered"
    CHECK ("low_value" IS NULL OR "high_value" IS NULL OR "low_value" <= "high_value");

-- Not constrained here, deliberately: the rule that rows sharing a `range_type`
-- must agree on their `unit`. It is a cross-row invariant over a set the
-- exclusion constraint does not partition, so expressing it needs either a
-- trigger or a `range_type -> unit` lookup table. #102 proposes exactly such a
-- table for per-type settable bounds, and the unit belongs in it — one place
-- naming what a range type means, rather than a second mechanism. Until then
-- `assertNoOverlap`'s check is the only enforcement, and that is now the ONLY
-- application-only rule on this table rather than all five.
