# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

**`apps/api` is scaffolded (P1.S1) and has its schema core (P1.S3); `packages/core` now has its shared kernel (P1.S4); everything else is not.** `apps/mobile` and `apps/web` still contain only a README marked "Not yet scaffolded," and there is no `apps/admin`. `packages/ui` and `packages/seed` do not exist as code either. `apps/api` has a NestJS skeleton — typed/validated config, the structurally separate patient/admin OIDC guards, a liveness health check, OpenAPI generation, and a structured Pino logger whose serializers never assemble a request/response body into a log line, backed by a credential-redaction list (not a "PHI-scrubbing" filter — no PHI payload is ever logged in the first place, so there is nothing for one to scrub) — plus a Prisma schema, one hand-authored migration, and a `PrismaService`/`PrismaModule` (P1.S3; see `design-specs/data-model/p1-s3-schema-coverage.md`). `PrismaService` is not yet wired into `AppModule`, and there is still no audit logging and no business-logic endpoint yet (those are P1.S5 and P2). See `apps/api/README.md`.

`packages/core` is an ESM package with five owned subpaths (ADR-0007) and no root `"."` export: `src/units` (canonical mL/kg types and conversion, mixed-system values unrepresentable in the type, ADR-0004/ADR-0005), `src/validation` (the two-tier engine — Tier 1 hard-blocks, Tier 2 warns via a return type structurally incapable of blocking — with thresholds injected, never hardcoded, and `ESTIMATION_METHOD_CODE` still `{ resolved: false }` pending D4 (a discriminated union, not `string | null`, so an unresolved code cannot silently typecheck as a Prisma `method` write)), `src/hydration` (the Daily Net Fluid Balance LOINC classification, voided urine excluded on purpose per §3.7 — nothing beyond that; the composite status is P6/P7), and `src/i18n` (the shared English catalog in separate `validationErrors`/`validationWarnings`/`redFlags`/`common` namespaces, plus `Intl` formatters). `apps/api` depends on it and `pnpm verify`'s `verify:core-require` step proves the CommonJS API can `require()` its built ESM output (ADR-0010). `src/sync` (P2.S0) holds the wire contract types for `docs/sync-contract.md` — that document governs, and the types are corrected to match it, never the reverse. Build outbound wire objects with the constructors it exports (`syncRejectedResult`, `syncDeltaTombstone`, ...), never by spreading a database row or a validation result into a literal: TypeScript's excess-property check does not apply to spread properties, so a spread typechecks cleanly and ships a deleted entry's clinical values or a rejection's offending value. `src/fhir` is not built yet (owned by `fhir-data-modeler`); `src/api-client` is generated and does not exist yet either. See `packages/core/README.md`.

**The toolchain does exist** (sprint P0). `packages/config` holds the shared tsconfig, ESLint flat config and Prettier config that every workspace extends, and the root has working commands:

```
pnpm install
pnpm verify    # check:env + format + lint + typecheck + test — exactly what CI runs
```

plus `lint`, `lint:fix`, `typecheck`, `test`, `test:unit`, `format`, `format:write`, `check:env`. `docs/getting-started.md` is authoritative; use those commands rather than inventing any. When an app is scaffolded, record its real commands there and update this file.

Three lint rules fail the build rather than warn, because each backs a constraint that would otherwise depend on memory: the AGPL header, the admin/patient import boundary, and no hardcoded user-facing strings in UI directories. They have tests in `packages/config/eslint/__tests__/` — extend those when you touch a rule; two of the three shipped broken the first time precisely because they had none.

Still deliberate `TBD` stubs: `docs/coding-standards.md` (waiting for code to standardize) and the app-specific sections of `docs/getting-started.md`. Filling them in as conventions get established is expected work, not scope creep.

## The source of truth: SRS_v2.md

`design-specs/requirements/SRS_v2.md` (currently v2.5) is the single authoritative spec. It is self-contained and supersedes `Ostomy_App_Specification_v1.pdf` (historical reference only — do not consult the PDF to answer architecture questions). All six spec phases — user functionality, non-functional requirements, technical architecture, v1 scope additions, weight tracking & composite hydration status, and resting heart rate & signal concordance — are approved, the most recent on 2026-09-05.

**When a spec phase is approved, update this file in the same change.** A stale pointer here is worse than no pointer, because sessions read it and trust it. Check three things: the version number above, the phase list, and any rule below that the new phase changes.

**v1 covers colostomy and ileostomy only.** Urostomy was deliberately cut in Phase 4 (Appendix A) because a urostomy's stoma output *is* urine, making it a different data model rather than a third enum value. Do not reintroduce it as an ostomy type.

Read it before making architectural or data-model decisions. Section 4 in particular contains decisions that are already made, not open questions.

## Decisions made since the spec: design-specs/decisions/

Architecture decision records live in `design-specs/decisions/`, indexed in its README. **An accepted ADR can supersede SRS_v2.md** — check the index before treating a spec statement as final, and read any ADR touching the area you are working in.

Nine are accepted (ADR-0001 to ADR-0009), covering the sync wire contract, testing strategy, monorepo tooling, canonical units, entry precision, i18n, `packages/core` ownership, admin API sequencing, and seed data. ADR-0001 (sync) and ADR-0007 (`packages/core` ownership) bind almost every sprint — read both before writing shared or sync code.

Record significant new decisions there using `0000-template.md`: choices that are expensive to reverse, that a future contributor would otherwise re-litigate, or that look arbitrary without their context. Routine implementation choices belong in the code, not an ADR. An ADR that changes something the spec states must update the spec — and this file, where it changes a rule below — in the same change, or the repo ends up with two answers to the same question.

## Architecture decisions already locked in

From SRS_v2 Section 4 — treat these as settled unless the user reopens them:

- **Monorepo** via pnpm workspaces (`apps/*`, `packages/*`). TypeScript throughout, including infrastructure. No task runner — plain pnpm scripts (ADR-0003). `packages/config` is the shared build/lint/format base every workspace extends.
- **Module systems differ by workspace.** The repo is ESM (`"type": "module"`); `apps/api` is **CommonJS** with `nodenext` resolution, because NestJS's decorator DI does not fit the ESM defaults (ADR-0010). Consequence you must respect: the API's CJS build relies on Node's `require(esm)`, which throws `ERR_REQUIRE_ASYNC_MODULE` on **top-level await** — so `packages/core`'s entry graph must never use it. Vitest transforms to ESM and will not catch this; only running the built API will.
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
- There are **four hydration signals**: net fluid balance, urine output, weight change, and resting heart rate. The patient dashboard shows one composite status with drill-down, escalating when two or more signals agree; the physician view keeps all four separate and uncombined. Don't combine them in the physician view, and don't show four bare numbers to the patient.
- Resting heart rate (LOINC 8867-4) stores measurement source and a resting-conditions flag as coded components; readings failing the resting check are saved and shown but **excluded from baseline computation**. An orthostatic pair is two linked observations with the postural rise derived, not stored.
- The heart-rate **red-flag threshold is a safety response, not validation**. The entry saves normally with no data-quality warning, and a separate prompt advises seeking care. Never route it through the validation warning path — that teaches patients to dismiss it. It is also the one threshold that is not patient-adjustable.
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
- **The API never runs as the database schema owner.** Two non-superuser roles: a migration/owner role for `migrate`, and a runtime role for request handling that holds `SELECT`/`INSERT` on `audit_events` and **no `UPDATE`/`DELETE`** (ADR-0011). Append-only is enforced by grant, not by convention — a superuser or table owner bypasses it and makes the P1.S5 audit test pass while proving nothing. Role and grant changes go in a **migration**, never only in a Compose init script: Testcontainers starts its own PostgreSQL and never sees one.
- **No real PHI outside production.** Dev and staging use synthetic or de-identified data.
- **Accessibility is a hard target, not polish**: WCAG 2.1 AA across both clients. The patient population skews older and post-surgical — screen-reader support, scalable text, and touch-target sizes are requirements.
- **No hardcoded user-facing strings.** v1 ships English-only, but all copy must be externalized and date/time/number/unit formatting must be locale-aware from day one. Patient-facing copy targets a 6th–8th grade reading level.
- **Units**: a single metric/imperial preference governs both volume and weight (mL+kg or oz+lb). Mixed-system combinations must be impossible to select — make them unrepresentable in the type, not merely unselectable in the UI. All logging and display respect it; stored canonical values are never rewritten when it changes. **Canonical storage is always mL and kg** regardless of preference; imperial is a render-time conversion only (ADR-0004).
- **Every observation write must supply the entered measurement system.** `observations.entered_measurement_system` is `NOT NULL` with no default (ADR-0012), resolved from the patient's profile **at write time, never at render time** — the profile is mutable, so deriving it later is wrong precisely for the patients who switched. It is what makes ADR-0005's conversion rounding implementable, and it is permanent per row: no later migration can recover the truth if it is stored wrongly.
- **Precision**: volume fields accept positive decimals, not integers. Tier 1 rejects negatives, **zero**, and non-numeric input. Stored values keep their entered precision. A volume *converted* between measurement systems is rounded to the nearest whole unit for display only — but **weight is excluded from that rule** and shows one decimal place in both systems, because rounding a converted weight to a whole unit would discard exactly the day-over-day changes the weight signal exists to detect (ADR-0005, SRS AC 2.1 AC 4).
- **Daily totals are computed from canonical values and rounded once, never summed from rounded per-entry display figures.** Daily Net Fluid Balance is one of the four hydration signals; accumulated display rounding across a day of entries is a clinical-accuracy defect (ADR-0005).

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
