# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This repo is **scaffolding only** — directory structure, docs, and specs. No application code, no `package.json` dependencies, no build/lint/test commands exist yet. `apps/mobile`, `apps/web`, and `apps/api` each contain only a README marked "Not yet scaffolded."

Consequences for any work here:
- There is nothing to build or run. Do not invent commands; when an app is scaffolded, record its real commands in `docs/getting-started.md` (which has `TBD` placeholders for exactly this) and update this file.
- Many `docs/*.md` files are deliberate `TBD` stubs (`coding-standards.md`, `git-workflow.md`, `testing.md`, parts of `security-hipaa.md`). Filling them in as conventions get established is expected work, not scope creep.

## The source of truth: SRS_v2.md

`design-specs/requirements/SRS_v2.md` (currently v2.1) is the single authoritative spec. It is self-contained and supersedes `Ostomy_App_Specification_v1.pdf` (historical reference only — do not consult the PDF to answer architecture questions). All four spec phases — user functionality, non-functional requirements, technical architecture, and v1 scope additions — are approved as of 2026-09-04.

**v1 covers colostomy and ileostomy only.** Urostomy was deliberately cut in Phase 4 (Appendix A) because a urostomy's stoma output *is* urine, making it a different data model rather than a third enum value. Do not reintroduce it as an ostomy type.

Read it before making architectural or data-model decisions. Section 4 in particular contains decisions that are already made, not open questions.

## Architecture decisions already locked in

From SRS_v2 Section 4 — treat these as settled unless the user reopens them:

- **Monorepo** via pnpm workspaces (`apps/*`, `packages/*`). TypeScript throughout, including infrastructure.
- **Mobile (`apps/mobile`)**: Expo managed workflow + React Native. The *only* offline-capable client — writes to local `expo-sqlite` first, appends to a local `sync_queue` table, pushes to the API on connectivity restore.
- **Web (`apps/web`)**: React + Vite SPA, **online-only** by explicit decision. No local persistence layer. Don't add offline support to web.
- **Admin console**: a *separate* internal React/Vite SPA with **zero PHI access**, managing value sets, clinical default ranges, and validation thresholds. Backed by its own Cognito user pool, disjoint from the patient pool, so the boundary is enforced at the identity layer rather than by authorization logic. It consumes an isolated `/api/v1/admin/...` surface and must never import patient data types. Not yet scaffolded — there is no `apps/admin` directory.
- **API (`apps/api`)**: Node.js + TypeScript, NestJS recommended (module/guard/interceptor patterns map onto RBAC, audit logging, and validation — the compliance requirements make this a deliberate choice over Express/Fastify). REST, not GraphQL, versioned as `/api/v1/...`. Prisma against PostgreSQL.
- **Database**: PostgreSQL with a **FHIR-shaped relational schema** — not a FHIR-native store. Clinical tables map their columns 1:1 to FHIR R4 fields; FHIR `Bundle` resources are assembled on demand by a dedicated export module.
- **Infrastructure**: AWS — Fargate/ECS for the API, RDS PostgreSQL Multi-AZ, S3 (SSE-KMS, presigned URLs) for photos and PDF exports, S3+CloudFront for the web build, Cognito as the OAuth2/OIDC IdP, Secrets Manager + KMS. IaC in AWS CDK (TypeScript). CI/CD via GitHub Actions (`.github/workflows/`, currently empty).
- **Conflict resolution**: last-write-wins by timestamp, applied server-side; the losing version is written to the audit log rather than discarded.

## Data model rules that are easy to get wrong

- Output/intake logs are FHIR R4 `Observation`. Persist and transmit using FHIR-standard field names (`resourceType: "Observation"`, `valueQuantity.value`, `effectiveDateTime`) — not a custom schema mapped later.
- The mandatory **"Measured vs. Estimated"** toggle on every volumetric entry is stored as `Observation.method`, populated with the SNOMED CT "Estimation technique" code when estimated. (The exact code is still an open question in `design-specs/data-model/fhir-rxnorm-integration.md`.)
- Medications are a **separate** `medication_administrations` table (FHIR `MedicationAdministration`), keyed by RxNorm RXCUIs — not rows in the observations table. UI shows patient-friendly terms; the backend maps them to RXCUIs.
- App-native entities (appliance changes, leak events, peristomal skin condition, reminders, Quick-Add templates) have no FHIR equivalent and are ordinary relational tables. This asymmetry is the accepted trade-off of the Postgres-over-FHIR-native decision.
- Body weight also shares the `observations` table (LOINC 29463-7), with `method` left unpopulated — the Measured/Estimated toggle applies to volumetric entries only, since a weight is read off a scale. Observation codes are LOINC; SNOMED CT is used only for the `method` attribute.
- There are **three hydration signals**: net fluid balance, urine output, and weight change. The patient dashboard shows one composite status with drill-down; the physician view keeps all three separate and uncombined. Don't combine them in the physician view, and don't show three bare numbers to the patient.
- Voided urine shares the `observations` table with other volumetric entries, distinguished by observation code — it is not a separate table. It is **excluded from Daily Net Fluid Balance on purpose**: net balance measures stoma losses, while urine output independently signals renal perfusion, and merging them would let a normal-looking balance hide a dangerously low urine output. Don't "fix" this by summing them.
- Value-set members are **retired, never deleted**. Clinical records reference them by stable code, so a retired value must still resolve when rendering history. No admin action may change what a past entry means.
- A patient's effective range is stored with its provenance — physician-set, patient-set, patient-confirmed suggestion, or clinical default, in that precedence order. An unconfirmed suggestion is never an active anomaly threshold.

## Validation

Two tiers, defined once in `packages/core`: hard block for structurally impossible input (negative volumes, future timestamps beyond clock skew, dates before the surgery date, missing Measured/Estimated), soft overridable warning for implausible-but-real values (the >2,000 mL rule is an instance of this class, not a special case). A warning must never become a block — a real 2,500 mL day is the data point the care team most needs.

Client-side validation, including offline on mobile, is a UX affordance only. Every rule is re-enforced server-side on write **and on every synced operation** — a payload from an offline device is untrusted input. A queued operation rejected server-side is retained locally and surfaced for correction, never dropped.

Numeric thresholds are admin-managed configuration, not constants in code.

## Non-negotiable constraints

These come from the spec and apply to every feature, not just "compliance work":

- **Never log PHI.** Every PHI create/edit/delete is audit-logged with user identity, timestamp, and before/after values, to an append-only store separate from application logs.
- **No real PHI outside production.** Dev and staging use synthetic or de-identified data.
- **Accessibility is a hard target, not polish**: WCAG 2.1 AA across both clients. The patient population skews older and post-surgical — screen-reader support, scalable text, and touch-target sizes are requirements.
- **No hardcoded user-facing strings.** v1 ships English-only, but all copy must be externalized and date/time/number/unit formatting must be locale-aware from day one. Patient-facing copy targets a 6th–8th grade reading level.
- **Units**: a single metric/imperial preference governs both volume and weight (mL+kg or oz+lb). Mixed-system combinations must be impossible to select. All logging and display respect it; stored canonical values are never rewritten when it changes.

## Development environment

Development does **not** run on AWS. It is a single shared Docker Compose stack on an on-premise Ubuntu LTS server: API, PostgreSQL, MinIO in place of S3, a mock OIDC provider in place of Cognito, both SPAs as static builds. LAN-only, plain HTTP, synthetic data only. Deployed by a self-hosted GitHub Actions runner (outbound-only, so no inbound firewall rule). Database persists across deploys; migrations run automatically; `dev-reset` wipes and reseeds. Full methodology in `docs/deployment-development.md`.

Two rules this imposes on application code:

- **Never import a Cognito SDK into request handling.** The API takes a standard OIDC issuer, JWKS URI, audience, and claim mapping as configuration. Cognito-specific behavior goes behind a provider adapter.
- **Never assume AWS-hosted S3.** Endpoint, region, credentials, and path-style addressing are configuration. MinIO requires path-style, so virtual-host-style URL assumptions break development outright.

Push delivery sits behind the same kind of adapter (Expo in production, log-only in development).

Nothing on this host may ever hold real PHI or a production credential — not temporarily, not to reproduce a bug. The runner's `docker` group membership means a host compromise is total, and the only defense that holds is that there is nothing valuable there.

Staging is the parity gate. Fargate orchestration, TLS, real Cognito, and KMS are untested until staging exists; `docs/deployment-development.md` lists the deferred risks that staging must cover.

## Licensing

AGPL-3.0-or-later. New source files in `apps/` and `packages/` get the license header from `docs/license-header.md` (a `/* ... */` block at the top for TS/JS).
