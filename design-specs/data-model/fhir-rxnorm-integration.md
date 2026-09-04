# FHIR & RxNorm Integration Notes

Working notes on the data-model mapping approach described in the SRS (`design-specs/requirements/Ostomy_App_Specification_v1.pdf`).

## FHIR mapping
- Output and intake logs map to the FHIR R4 `Observation` resource.
- The "Measured vs. Estimated" distinction is stored as an explicit `Observation.method` attribute, using the appropriate SNOMED CT code for "Estimation technique" when estimated.
- JSON payloads should use FHIR-standard field names directly (e.g. `resourceType: "Observation"`, `valueQuantity.value`) rather than a custom schema that's mapped later.

## RxNorm / medication
- Medication records are stored using RxNorm Concept Unique Identifiers (RXCUIs).
- The UI presents patient-friendly terminology; the backend maps patient selections to RXCUIs so data is semantically interoperable with provider EHRs.

## Open questions
_TBD — exact SNOMED CT code(s) to use for estimation technique, which RxNorm subset/API to query, versioning strategy for FHIR resources as the schema evolves._
