# FHIR & RxNorm Integration Notes

Working notes on the data-model mapping approach described in
`design-specs/requirements/SRS_v2.md` §4.4. (Previously this pointed at
`Ostomy_App_Specification_v1.pdf` — that PDF is historical reference only
per `CLAUDE.md`; the pointer was stale and is fixed here, per implementation
plan finding F3.)

## FHIR mapping

- Output, intake, voided urine, body weight, and (later) resting heart rate
  all map to the FHIR R4 `Observation` resource, in one relational
  `observations` table distinguished by `code` — never a separate table per
  entry type. See `apps/api/prisma/schema.prisma`'s `Observation` model
  (P1.S3) for the exact column-to-FHIR-field mapping and
  `design-specs/data-model/p1-s3-schema-coverage.md` for the full coverage
  note.
- The "Measured vs. Estimated" distinction is stored as an explicit
  `Observation.method` attribute, using the SNOMED CT code for "Estimation
  technique" when estimated, for **volumetric entries only** — body weight
  and resting heart rate leave `method` unpopulated (SRS §4.4).
- JSON payloads use FHIR-standard field names directly (e.g.
  `resourceType: "Observation"`, `valueQuantity.value`) rather than a
  custom schema mapped later.
- `Observation.valueQuantity.unit`/`.code` are always the **canonical**
  unit (mL or kg, ADR-0004) on the wire, regardless of which measurement
  system the patient entered the value in. As of the
  `fix/entered-measurement-system` follow-up migration (after P1.S3/P1.S4),
  `observations.entered_measurement_system` (`METRIC`/`IMPERIAL`) records
  that entry system as a separate column — **it is app-native provenance,
  not a FHIR element.** FHIR R4 `Observation` has no field for "what system
  was this value entered in"; a `Bundle` assembled by the export module
  emits `valueQuantity` exactly as it already does today, unaffected by
  this column's existence. Resolved this way rather than folding the entry
  system into `valueQuantity` itself (e.g. by NOT converting to canonical
  units before storage) because ADR-0004 already settled that storage is
  canonical, unconditionally, and reopening that is a much larger change
  than adding one provenance column. If a future need arises to expose
  entry-system provenance to a FHIR-consuming downstream system (there is
  none identified today), the mechanism would be a non-standard
  `extension` on the `Observation` resource, not a repurposed core field —
  flagged as an open question below rather than built speculatively.

## RxNorm / medication

- Medication records are stored using RxNorm Concept Unique Identifiers
  (RXCUIs), in a separate `medication_administrations` table (FHIR
  `MedicationAdministration`) — not built yet; arrives with the medication
  feature per the implementation plan.
- The UI presents patient-friendly terminology; the backend maps patient
  selections to RXCUIs so data is semantically interoperable with provider
  EHRs.

## Verified LOINC codes

Looked up rather than guessed, per the standing rule that a wrong LOINC
code is a silent, durable data-quality defect. Each was cross-checked
against a second independent mirror of the LOINC database (`findacode.com`,
which republishes LOINC's own Component/Property/Time/System/Scale/Class
fields) after `loinc.org` itself returned HTTP 403 to automated fetches;
where a code is also used in a published FHIR profile (US Core), that is
noted as additional corroboration.

| Code       | Long common name                                                  | Used for                                    | Verified via |
| ---------- | ------------------------------------------------------------------ | -------------------------------------------- | ------------ |
| `79560-9`  | Fluid output gastrointestinal ostomy [Volume] Measured             | Stoma output                                 | loinc.org / findacode.com — Component "Fluid output.gastrointestinal ostomy", Property Vol, Time Pt, System "Gastrointestinal system", Scale Qn, Class IO_OUT.MOLEC |
| `9000-1`   | Fluid intake oral Measured                                         | Fluid intake                                 | loinc.org / findacode.com — Component "Fluid intake.oral", Property Vol, Time Pt, System "Upper GI tract", Scale Qn, Class IO_IN.MOLEC |
| `9187-6`   | Urine output                                                        | Voided urine (point-in-time)                 | loinc.org / findacode.com — Component "Fluid output.urine", Property Vol, Time Pt (spot/random), System "Urinary tract", Scale Qn, Class IO_OUT.MOLEC |
| `29463-7`  | Body weight                                                         | Body weight (already cited in `CLAUDE.md`)   | loinc.org / findacode.com; also the code used by the FHIR US Core Body Weight profile |
| `8867-4`   | Heart rate                                                           | Resting heart rate (already cited in `CLAUDE.md`; not yet written by any endpoint) | loinc.org / findacode.com; also the code used by the FHIR US Core Heart Rate profile |

Notes on the LOINC-vs-app-model mismatch worth flagging for a future
reader: LOINC itself publishes separate codes for the *Measured* and
*Estimated* variants of some of these components (e.g. `9000-1` "...
Measured" vs `8999-5` "... Estimated" for oral fluid intake). This
application deliberately does **not** follow that split — the
Measured/Estimated distinction is carried once, uniformly, as
`Observation.method` (CLAUDE.md), so every volumetric entry uses the single
"Measured"-named code above regardless of which toggle position the patient
selected. Checked specifically for `79560-9` (gastrointestinal ostomy
output): no separate "Estimated" LOINC code for that component/time-aspect
combination was found, so there is no unused alternative being left on the
table there either way.

## Resolved terminology

- **SNOMED CT code for an estimated volumetric entry (`Observation.method`)
  — RESOLVED.** `414135002` |Estimated (qualifier value)|, per
  [ADR-0018](../decisions/0018-estimation-method-snomed-code.md). Published
  from `packages/core`'s `ESTIMATION_METHOD_CODE`; `apps/api` reads that
  constant rather than a copy, so there is exactly one place this value
  lives. `null` remains the measured representation — see the first open
  question below.

  **Changing this value is a data migration, not an edit.** Rows already
  written keep the old code and nothing detects the disagreement until FHIR
  export or EHR integration, which is the failure mode this decision stayed
  open for so long to avoid.

## Open questions

- **Whether `method: null` should become an explicit |Measured| code.**
  SNOMED CT `258104002` |Measured (qualifier value)| is the paired concept
  and is real. Today `null` means both "volumetric entry, measured" and
  "weight entry, toggle does not apply", separated only by the row's `code`
  — an inference that is sound inside this system and invisible outside it,
  since an exported `Observation` with no `method` says *not stated*, not
  *measured*. Free to change now, a versioned coordinated-release change
  once clients ship. See [ADR-0018](../decisions/0018-estimation-method-snomed-code.md)
  "What this does not change" for the full argument. **The export module
  (P5) is the first place this actually bites.**
- Which RxNorm subset/API to query for medication lookups — not yet
  scoped; medications are out of P1.S3's scope entirely.
- Versioning strategy for FHIR resources as the schema evolves — not yet
  decided; the FHIR export module itself (assembling `Bundle` resources on
  demand) is not built yet either. See
  `design-specs/data-model/p1-s3-schema-coverage.md` for what a `Bundle`
  from the P1.S3 tables would look like once it is.
- Resting heart rate's own coded components (measurement source,
  resting-conditions flag) and voided urine's coded color component (SRS
  §4.4) are deliberately not part of the P1.S3 `observations` table shape —
  they arrive as additive `ALTER TABLE` migrations with their own features,
  per the implementation plan's "deliberately partial" instruction for that
  sprint.
- **Whether `entered_measurement_system` should ever be exposed on the wire
  as a FHIR `extension`.** Not resolved, and not blocking: no downstream
  FHIR consumer has asked for entry-system provenance, and the export
  module does not exist yet regardless. If this is ever needed, the shape
  would be an `Observation.extension` entry with an application-owned
  `url` (not a published FHIR extension — there is no standard one for
  this), carrying `METRIC`/`IMPERIAL` as a `valueCode`. Recorded here so
  whoever eventually builds the export module does not have to
  independently rediscover that this column exists and has no home in the
  core resource fields.
