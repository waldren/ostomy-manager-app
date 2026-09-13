-- ADR-0016: a "day" is the patient's local day, captured at write time.
--
-- `effective_datetime` is an instant, and the SRS uses "daily" throughout
-- without defining where a day starts. Grouping by the UTC day puts
-- everything a patient at UTC-6 logs after 6pm into the next day, splitting
-- an evening's stoma output across two days neither they nor their
-- clinician would recognise. Daily Net Fluid Balance is the headline
-- hydration signal, so this is a clinical-accuracy defect, not a display
-- one.
--
-- NOT NULL with no default, and no backfill, on exactly the
-- `entered_measurement_system` precedent (ADR-0012): the instant alone does
-- not say where the patient was, so a row written without this can never
-- have it recovered. Safe to add unconditionally because this table has no
-- production rows; it would be impossible to add correctly once it did.
--
-- `entered_timezone` is an IANA zone name, not a UTC offset. An offset is
-- ambiguous across DST — "-05:00" does not say whether the next entry
-- should be "-05:00" or "-06:00" — so the grouping would break twice a
-- year. 64 characters is comfortably above the longest IANA identifier
-- ("America/Argentina/ComodRivadavia", 33).
ALTER TABLE "observations"
  ADD COLUMN "entered_timezone" VARCHAR(64) NOT NULL,
  ADD COLUMN "local_date" DATE NOT NULL;

-- The daily-aggregate index. Every "totals for a day" query groups by
-- local_date, and that is the query the patient dashboard and the physician
-- view both run constantly.
CREATE INDEX "observations_patient_id_code_local_date_idx"
  ON "observations" ("patient_id", "code", "local_date");
