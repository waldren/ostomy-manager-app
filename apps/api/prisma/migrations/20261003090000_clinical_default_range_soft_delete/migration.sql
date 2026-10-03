-- Soft delete and restore for clinical_default_ranges (#98).
--
-- #98's remaining half: "recovering a row means a human reading JSON out of
-- `audit_events` and retyping it. The audit log is not readable through any
-- API." P3.S3 PR C returns the deleted row's snapshot in the 200 body for
-- exactly that reason, and the issue is right that it "helps the admin who
-- notices immediately and nobody else".
--
-- ## This reverses a decision CLAUDE.md states prominently, deliberately
--
-- "`clinical_default_ranges` is the one admin surface that hard-deletes." That
-- sentence is now wrong and is corrected in the same change.
--
-- It is a reversal rather than a contradiction, and the distinction matters for
-- anyone re-reading the original reasoning. The hard delete was justified by
-- **safety**: nothing references a default range, because a patient's
-- `effective_ranges` row carries its own bounds with `CLINICAL_DEFAULT`
-- provenance — a copy, not a pointer — so removing one cannot alter a range any
-- patient already has. All of that is still true. What it never addressed was
-- **recoverability**, which is what #98 asked about. Soft delete adds the second
-- without weakening the first.
--
-- Precedent exists twice in this schema: `deleted_at` tombstones on
-- `observations` and `meals` (there for the sync delta cursor), and
-- `status`/`retired_at` on `value_set_members` ("retired, never deleted"). The
-- reasons differ — a value-set member is retired because stored entries resolve
-- their meaning through its code, whereas a default range is tombstoned purely
-- so it can be brought back — so this is the mechanism of the second with the
-- motivation of neither. Worth saying, because a reader who assumes the
-- value-set reasoning applies here will conclude a tombstone must never be
-- hard-removed, and that is not a claim this makes.
ALTER TABLE "clinical_default_ranges"
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- ## The constraint has to stop seeing tombstones, or the restore is pointless
--
-- #97's exclusion constraint refuses overlapping day windows. Left as it was, a
-- tombstone would keep occupying its window — so after deleting a row an admin
-- could not create a replacement covering the same days, which is the
-- delete-and-create correction path the window's immutability makes necessary.
-- The feature would have blocked the workflow it exists to support.
--
-- A partial exclusion constraint is the fix: `WHERE (deleted_at IS NULL)` makes
-- the rule apply among live rows only. Two consequences, both intended:
--
--   * Several tombstones may overlap each other and a live row. They are
--     history, not configuration, and nothing reads them.
--   * A RESTORE can therefore fail, where the delete-and-create path has since
--     filled the window. That is a real state and not an edge case — it is the
--     ordinary sequence — so the service translates it into a 409 naming the
--     rule rather than letting a Postgres violation surface as a 500.
ALTER TABLE "clinical_default_ranges"
  DROP CONSTRAINT "clinical_default_ranges_window_no_overlap";

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
  ) WHERE ("deleted_at" IS NULL);

-- The list path filters on this, and §3.9's future seeding must too — a reader
-- that picked up a tombstone would seed a range an admin had withdrawn.
CREATE INDEX "clinical_default_ranges_live_idx"
  ON "clinical_default_ranges" ("ostomy_type", "range_type")
  WHERE "deleted_at" IS NULL;

-- No grant change. The runtime role already holds UPDATE on this table, which a
-- tombstone write needs, and it keeps DELETE — which is now unused by the
-- service but is left in place deliberately: withdrawing it is a separate
-- decision from this one, and ADR-0017's purge job runs as the owner role
-- regardless. #98 does not claim a tombstone can never be hard-removed.
