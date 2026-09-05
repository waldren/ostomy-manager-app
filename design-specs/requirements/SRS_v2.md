# Software Requirements Specification — Ostomy Patient Management Application (v2.2)

Prepared by: Steven E. Waldren, MD, MS
Supersedes: `Ostomy_App_Specification_v1.pdf` (v1.0), which is retained only as a historical reference — this document is fully self-contained and does not require consulting the v1.0 PDF.
Status: all five discussion phases complete.

| Phase | Topic | Status |
|---|---|---|
| 1 | User Functionality | ✅ Approved 2026-09-04 |
| 2 | Non-Functional Requirements (Performance, Security, Availability, Usability/Accessibility) | ✅ Approved 2026-09-04 |
| 3 | Technical Architecture | ✅ Approved 2026-09-04 |
| 4 | v1 Scope Additions (urine output, data validation, suggested ranges, onboarding & preferences, administration console) | ✅ Approved 2026-09-04 |
| 5 | Weight Tracking & Composite Hydration Status | ✅ Approved 2026-09-04 |

**Phase 4 scope change:** v1 now targets **colostomy and ileostomy only**. Urostomy support is deferred — see Appendix A for the rationale.

Sections below are updated as each phase is completed. Sections not yet revisited are carried forward from v1.0 unchanged and marked as such.

---

## 1. Executive Summary & Product Vision
*(carried forward from v1.0, unchanged — may be revisited once Phase 3 is complete)*

This application is a dual-platform (Mobile & Web) patient-facing diary designed to help ostomy patients track and manage stoma output, fluid intake, meals, and medication administration. The primary market differentiator is its ability to seamlessly integrate input, output, and medication timing to inform both the patient and their healthcare providers on the efficacy of the current care plan. While version 1.0 operated as a standalone patient diary, the architecture is designed from day one to support future electronic health record (EHR) interoperability (via FHIR) and advanced AI/predictive capabilities.

## 2. Platforms & Accessibility
*(carried forward from v1.0, unchanged — accessibility requirements are now formally specified in Section 5.4)*

- **Cross-Platform Availability:** The application must be fully functional and accessible via a native/hybrid mobile application (iOS and Android) as well as a standard web browser.
- **Offline-First Architecture:** Because patients will track data on-the-go (e.g., in public restrooms or while traveling), the application must utilize a local database (e.g., SQLite or Realm) to allow continuous data entry and historical review without an active internet connection. Data will automatically synchronize with the central secure cloud server once connectivity is restored.

## 3. Core Features & Workflows (User Functionality)
*(Phase 1 — approved 2026-09-04; Sections 3.7–3.11 added in Phase 4; Section 3.12 added in Phase 5)*

Sections 3.0–3.10 and 3.12 are patient-facing. Section 3.11 describes the internal administration console. The administration console retains its number despite the ordering, because Section 3.11 is referenced from the engineering documentation and renumbering would silently invalidate those references.

### 3.0 Onboarding & Profile Setup — NEW
*(Phase 1; minimum-required-fields rule added in Phase 4)*
- **Ostomy Type Selection:** During onboarding, the patient selects their ostomy type — **colostomy or ileostomy** (v1 scope; urostomy deferred, see Appendix A). This drives clinically appropriate default expected-output ranges rather than a one-size-fits-all baseline.
- **Surgery/Ostomy Creation Date:** Captured to contextualize the elevated-output risk typical of the early post-operative period, and used as the lower timestamp bound for entry validation (Section 3.8).
- **Minimum Required Before First Entry (Phase 4):** Only three fields are mandatory before the patient can log — ostomy type, surgery date, and measurement system. Each drives something that cannot be safely defaulted: expected-range selection, post-op context, and every volume and weight display respectively. All remaining steps are offered during onboarding but skippable, with contextual prompts to complete them later (Section 3.10). This matters because a newly discharged patient may be setting the app up in a hospital bed; a long mandatory setup flow is where they abandon it.
- **Physician-Set Target Ranges:** The patient can enter (or a future physician portal can set) target ranges for daily output, net fluid balance, and anomaly thresholds. These personalize the anomaly-highlighting feature (Section 3.5) to the patient's actual care plan rather than generic population defaults. Fields are pre-filled from the suggested ranges in Section 3.9 rather than presented blank. The patient may edit these, but edits that diverge from a physician-entered default are flagged.
- **Measurement System Preference (revised in Phase 5):** The patient selects metric or imperial, and that single choice governs every dimension — metric yields mL and kg, imperial yields oz and lb. This supersedes the Phase 1 mL/oz-only preference: adding weight (Section 3.12) introduced a second unit dimension, and a single system toggle prevents incoherent combinations such as mL paired with pounds. All logging and display respect this preference.
- **Baseline Appliance Type:** Optional and deferrable, seeds default appliance-change reminder cadence (Section 3.4).

### 3.1 Data Entry: Intake, Output, and Meals
*(carried forward from v1.0, unchanged)*
- **Volumetric Tracking (mL):** Patients must be able to log output and fluid intake precisely in milliliters (mL).
- **"Measured" vs. "Estimated" Flag:** Every volumetric entry must include a mandatory toggle indicating whether the volume was strictly measured or estimated.
- **Chart by Exception & Dynamic Widgets:** The application analyzes the user's latest entries to generate dynamic "Quick-Add" widgets on the dashboard, tappable for instant logging or editable as a pre-filled template.

### 3.2 Appliance & Peristomal Skin Health Tracking — NEW
- **Appliance (Pouch/Wafer) Change Logging:** Timestamped logging of each appliance change, with wear time auto-calculated from the prior change.
- **Leak Tracking:** Severity (minor/major) and an optional suspected-cause tag (activity, diet, seal failure).
- **Peristomal Skin Condition Logging:** Quick severity scale (normal / mild / moderate / severe irritation), optional free-text note, optional photo attachment.
- **Trend Views:** Average wear time and leak frequency over time, surfaced in both the patient dashboard and the physician-focused view (Section 3.5).

### 3.3 Medication Management
*(carried forward from v1.0, unchanged; now also feeds Reminders, Section 3.4)*
- **Targeted Medication Focus:** Treatments that manage ostomy symptoms (anti-diarrheals for high-output, hydration supplements, barrier creams).
- **RxNorm Integration & Patient-Friendly Terminology:** Backend uses RxNorm for standardized nomenclature; UI presents patient-friendly search terms.
- **Timestamping:** Precise recording of administration times to correlate drug efficacy with output spikes.

### 3.4 Reminders & Notifications — NEW
- **Medication Reminders:** Configurable per medication, scheduled manually or derived from logged administration patterns.
- **Appliance-Change Reminders:** Adaptive, based on the patient's own historical average wear time; manually adjustable.
- **Hydration/Intake Nudges:** Triggered when logged fluid intake trends low relative to output or the physician-set target, and when a significant weight change suggests fluid loss (Section 3.12).
- **Weigh-In Reminders (Phase 5):** Their own reminder category, defaulting to a daily morning prompt and independently configurable. Weight is only a usable signal when readings are taken consistently, and the reminder is the mechanism that produces that consistency.
- **Notification Preferences:** Independent enable/disable per reminder category; quiet-hours setting.

### 3.5 The Physician-Focused View (Care Plan Efficacy)
*(carried forward from v1.0, extended)*
- **Daily Net Fluid Balance:** Total fluid intake minus total stoma output (and other recorded losses), prominently displayed to highlight dehydration trends.
- **Chronological Correlation Visuals:** Data visualized across time periods (Morning, Afternoon, Evening, Night); line/bar graphs overlay medication administration times and fluid intake against stoma output volumes. **Extended:** appliance-change and skin-condition events are now overlaid on the same timeline so a physician can correlate a leak or irritation flare with intake/output/medication patterns.
- **Urine Output Adequacy (Phase 4):** The daily voided-urine total is displayed as its own hydration indicator alongside net fluid balance — deliberately not folded into it (Section 3.7) — and its events are overlaid on the same chronological timeline.
- **Weight Trend (Phase 5):** Body weight and its change against the patient's baseline, displayed as a third distinct hydration signal and overlaid on the same chronological timeline. The physician view keeps net fluid balance, urine output, and weight **separate and uncombined** — the composite status described in Section 3.12 is a patient-facing simplification only. A clinician assessing dehydration needs to know which signal moved, not a derived score.
- **Outlier & Anomaly Highlighting:** Automatically flags anomalies (e.g., output exceeding 1,000 mL/day while intake remains low, or a significant weight drop against baseline), now using the patient's personalized target ranges from Section 3.0 where available, falling back to generic defaults otherwise.

### 3.6 Data Management & History — NEW
- **Edit/Delete Past Entries:** Patients can correct a mis-logged entry. The system retains an audit trail (original + corrected value) for clinical integrity — this also feeds into Section 5.2 (Security & Compliance) audit-logging requirements.
- **Filter/Search History:** By category (output, intake, meds, meals, appliance, skin).
- **Full History Export:** A complete personal-record export, distinct from the physician-summary export.

### 3.7 Urine Output & Hydration Tracking — NEW
*(Phase 4)*

Rationale: for colostomy and especially high-output ileostomy patients, a falling urine output is often the earliest objective sign of dehydration — it frequently precedes symptoms and shows up before net fluid balance alone makes the problem obvious.

- **Voided Urine Logging:** Volume in mL or oz, per the Section 3.0 measurement system preference, carrying the same mandatory Measured/Estimated toggle as every other volumetric entry (Section 3.1).
- **Optional Color:** A standard pale-to-dark urine color scale as a practical hydration proxy for patients who will not measure volume. Each step carries a text label as well as a swatch — color must never be the sole carrier of meaning (Section 5.4).
- **Excluded from Net Fluid Balance — deliberately:** Voided urine is *not* added to total output in the Section 3.5 Daily Net Fluid Balance. It is displayed as its own hydration-adequacy indicator. The two figures answer different clinical questions: net balance measures stoma losses against intake, while urine output independently indicates whether the kidneys are being adequately perfused. Folding urine into total output would let a reassuring-looking net balance mask a dangerously low urine output — exactly the signal this feature exists to surface.
- **Quick-Add Eligible:** Urine entries participate in the dynamic Quick-Add widget logic (Section 3.1).
- **Trend View:** Daily urine output over time, plotted against the suggested or physician-set adequacy range (Section 3.9), in both the patient dashboard and the physician-focused view.

### 3.8 Data Validation — NEW
*(Phase 4)*

A two-tier model. The governing principle is that the app may refuse structurally impossible data, but must never refuse a patient's account of what actually happened.

**Tier 1 — Hard Block (cannot be saved):**
- Non-numeric or negative volumes, and zero where a positive value is required.
- Timestamps in the future, beyond a small allowance for device clock skew.
- Entry timestamps earlier than the recorded surgery/ostomy creation date (Section 3.0).
- A missing mandatory Measured/Estimated selection (existing acceptance criterion, Section 7).
- Values above an absolute physiological ceiling configured per entry type (Section 3.11), including an absolute plausible-weight range (Section 3.12).

**Tier 2 — Soft Warning (implausible but possible; always overridable):**
- Single-entry volumes above the configured warning threshold — the existing >2,000 mL rule is one instance of this class, not a special case.
- Daily totals falling far outside the patient's suggested or physician-set range (Section 3.9).
- A weight reading whose change from the previous reading exceeds a plausible day-over-day threshold — typically a mis-keyed digit or a unit confusion rather than a real measurement (Section 3.12).
- Warning copy states plainly what looks unusual and asks for confirmation. It never blocks and never scolds — a genuine 2,500 mL output day is precisely the data point the care team most needs to see.

**Where validation runs:** Rules are defined once in `packages/core` and executed client-side — including offline on mobile — for immediate feedback, then re-enforced server-side on every write and on every synced operation. Client-side validation is a user-experience affordance, never the enforcement point: a payload arriving from an offline device is untrusted input like any other.

**Thresholds are configuration, not code:** All numeric bounds come from the admin-managed tables in Section 3.11, so clinical tuning does not require a deploy.

**Interaction with offline sync:** A queued offline operation that fails Tier 1 validation server-side is never silently dropped. It is surfaced to the patient for correction and retained locally until resolved, consistent with the Section 5.3 commitment that no logged data is lost.

### 3.9 Suggested Ranges — NEW
*(Phase 4)*

The app proposes starting values for intake goals, expected output, excessive-output thresholds, urine output adequacy, and net fluid balance targets, so a new patient is not asked to invent clinical numbers they have no basis to choose.

- **Seeded from clinical defaults:** Initial suggestions come from admin-managed default range tables (Section 3.11) keyed to ostomy type and time since surgery, so there is useful guidance from day one. Weight-change thresholds and target dry weight (Section 3.12) participate in this same system, including the same precedence order.
- **Presented, not imposed:** A suggestion appears as a pre-filled value with its basis stated in plain language (e.g. "typical for an ileostomy about 3 months after surgery"). The patient accepts or edits it. No value becomes an active threshold without a human confirming it.
- **Adaptation requires confirmation:** Once enough history accumulates to refine a range toward the patient's own rolling baseline, the app proposes the change and explains why; the patient accepts or keeps the current value. Adaptation is never silent — a threshold that quietly tracks a worsening baseline would normalize deterioration and suppress the very anomaly flags meant to catch it.
- **Physician-set values are never auto-changed:** A physician-entered target is only ever flagged as diverging, consistent with Section 3.0.
- **Precedence, highest first:** physician-set → patient-set → patient-confirmed suggestion → clinical default.
- **Framing constraint:** Patient-facing copy describes suggestions descriptively — what is typical for people with a similar profile — rather than prescriptively. Suggested ranges are informational context for the patient and their care team; they are not a treatment recommendation, and copy must not present them as one.

### 3.10 Preference Management — NEW
*(Phase 4)*

A persistent settings area, reachable at any time, covering everything onboarding collects plus what accumulates through use:

- **Profile:** ostomy type and surgery date. Both are editable but audit-logged, since the surgery date is a validation boundary (Section 3.8) and the ostomy type drives range selection.
- **Measurement system:** metric or imperial, governing both volume and weight (Section 3.0). Changing it re-renders historical data in the new units; the stored canonical value is never rewritten.
- **Weight tracking:** enable or disable weight logging and its reminder, and review or set the target dry weight (Section 3.12).
- **Target ranges and suggestion review:** current values, their source per the Section 3.9 precedence order, and any pending suggested adaptations awaiting confirmation.
- **Notifications:** per-category enable/disable and quiet hours (Section 3.4).
- **Appliance defaults:** baseline appliance type and reminder cadence.
- **Quick-Add templates:** review, edit, pin, or remove the dynamically generated widgets (Section 3.1), so a patient is not stuck with a suggestion that no longer matches their routine.
- **Accessibility:** text scaling and contrast options, honoring OS-level settings where the platform exposes them (Section 5.4).
- **Data and privacy:** full history export (Section 3.6) and patient-initiated account/data deletion (Section 5.2).
- **Deferred onboarding:** prompts to complete any step skipped under the Section 3.0 minimum-fields rule.

Preferences synchronize across devices via the Section 4.5 pull-sync delta endpoint; preference changes made on mobile are queued like any other write.

### 3.11 Administration Console — NEW
*(Phase 4)*

An internal tool for developers and clinical staff to manage the terminology and thresholds the application runs on, without requiring a code deploy for every clinical adjustment.

- **Zero PHI access — an architectural boundary, not a policy:** The console has no route to patient data. It is a separate application backed by a separate identity pool (Section 4.6), so an admin credential cannot address a patient endpoint even if compromised. This keeps the console outside PHI scope by construction rather than by correct authorization logic alone.
- **Manages clinical value sets:** output consistency, fluid types, meal quick-tags, leak suspected-cause tags, peristomal skin severity levels, appliance types, and the urine color scale (Section 3.7).
- **Manages clinical default range tables:** the published defaults keyed to ostomy type and post-operative period that seed Section 3.9 suggestions, including the weight-change percentage thresholds and rolling-window definitions used by Section 3.12.
- **Manages validation rule thresholds:** the numeric bounds behind the Section 3.8 warn and block tiers, including the soft-warning volume threshold and the absolute physiological ceilings.
- **Explicitly not managed here:** patient-facing copy and terminology display labels. These stay in the externalized i18n string catalog (Section 5.4); routing them through the console would fork the localization pipeline into two systems.
- **Retire, never delete:** Value-set members carry an active/retired status. Retiring a value removes it from pickers going forward while historical entries continue to resolve and render normally. No administrative action ever changes the meaning of previously recorded clinical data or leaves a blank in a patient's history.
- **Audit logging:** Every change is logged with admin identity, timestamp, and before/after values, in the same append-only audit store as PHI actions (Section 5.2). These settings shape clinical thresholds, so they warrant equivalent rigor.
- **Access control:** MFA mandatory on all admin accounts; least-privilege roles within the console.

### 3.12 Weight Tracking & Hydration Status — NEW
*(Phase 5)*

Rationale: acute weight change is among the most reliable indicators of fluid loss, and it is independent of both the intake/output arithmetic and urine output — so it catches dehydration that those two signals miss, particularly when a patient's logging is incomplete.

**Logging**
- **Weight Entry:** Recorded in kg or lb per the Section 3.0 measurement system preference, to one decimal place.
- **Not a volumetric entry:** The mandatory Measured/Estimated toggle (Section 3.1) does **not** apply. That flag exists to convey the precision of an estimated volume; a weight is read from a scale or it is not recorded at all.
- **Timestamped, with consistency handling:** Every reading keeps its timestamp. Onboarding explains the same-time-daily convention in plain language, and the app notes when a comparison spans substantially different times of day rather than treating those readings as equivalent — normal diurnal variation is the same magnitude as a genuine dehydration signal, so comparing an evening reading against a morning one manufactures false flags.
- **Manual entry only:** Smart-scale and health-platform integration is deferred (Appendix A).

**Baseline**
- The reference weight is a **rolling baseline** computed from the patient's own recent stable readings, so it tracks legitimate post-operative weight recovery instead of treating months of normal regain as a continuous gain anomaly.
- A **physician-set target dry weight** overrides the computed baseline where one exists, following the Section 3.9 precedence order (physician-set → patient-set → patient-confirmed suggestion → clinical default).

**Significant change**
- Thresholds are defined and evaluated as **percent change over rolling windows**, which is the clinical convention and scales correctly across body sizes. Default windows and percentages are admin-managed (Section 3.11).
- Patient-facing copy expresses the change in **absolute terms** — "you are down 2 kg since last week" — consistent with the plain-language standard in Section 5.4. Percentage of body weight is precise but not something most patients parse quickly.
- A significant drop both flags in the physician view (Section 3.5) and prompts the patient with plain-language guidance to increase fluids and to contact their care team if it continues. Weight change is directly actionable by the patient, unlike most anomaly flags, so surfacing it only to a clinician who may not review the data for weeks wastes the signal.

**Composite hydration status**
- The **patient dashboard** presents a single plain-language hydration status derived from net fluid balance, urine output (Section 3.7), and weight change, with the contributing signals visible on tap. Three related numbers on one dashboard is a genuine comprehension burden for this population (Section 5.4); one clear status with drill-down is not.
- The **physician view keeps all three separate** (Section 3.5). The composite exists to make the patient's dashboard legible, not to summarize away clinical detail.
- The composite must always be explainable: the patient can see which signal drove the status, and a status is never shown without the underlying readings being reachable.

**Framing and opt-out**
- Weight is presented throughout as a **hydration measure**, not as a body-composition or weight-management metric. Copy, iconography, and dashboard placement must all reflect that.
- Weight tracking is **on by default** but can be turned off in preferences (Section 3.10), which also disables its reminder and removes it from the composite status. Default-on because a patient who never discovers the feature loses the signal precisely when high output puts them most at risk; switchable off because daily weighing is not appropriate for everyone.

### Appendix A: Functionality Considered and Deferred
The following were discussed and deliberately excluded from v1/v2 scope, with rationale, so they remain a conscious decision rather than a silent omission:
- **Wearable and connected-device integration** (Apple Health / Google Fit auto-logging of fluid intake or weight, and Bluetooth smart scales feeding Section 3.12) — deferred; adds a full integration surface, better suited to a post-launch release. Weight is entered manually in v1.
- **Patient education/resource library** — deferred; this is content work rather than a data/workflow feature and can be scoped as its own initiative.
- **Gamification (streaks, badges)** — deferred; risks undercutting the clinical seriousness of the tool unless designed carefully.
- **Caregiver/provider portal accounts with ongoing live access** — deferred beyond the existing one-off read-only export/share-link; a full second user type is a materially larger scope and compliance surface.
- **Urostomy support** — deferred from v1 in Phase 4; v1 targets colostomy and ileostomy only. A urostomy's stoma output *is* urine, which makes it a materially different data model rather than a third dropdown option: the stoma output becomes the hydration signal itself instead of a loss to be offset against intake, the expected ranges and anomaly thresholds are unrelated to those for fecal output, and the complication profile centers on urinary tract infection and crystal formation rather than the skin and leak concerns of Section 3.2. Supporting it properly is its own scope of work, not a variant of the existing flows.

## 4. Technical Architecture
*(Phase 3 — approved 2026-09-04)*

### 4.1 System Overview
- **Mobile app** (Expo/React Native, iOS + Android) — the primary offline-capable client. Writes to a local SQLite database first, then syncs to the backend when connectivity is available.
- **Web app** (React SPA) — online-only client (per Phase 3 scope decision); reads/writes go directly to the backend API, no local persistence layer beyond normal browser caching.
- **Backend API** (Node.js/TypeScript) — the single system of record; exposes a versioned REST API consumed by both clients; owns authentication, business logic, FHIR-shaped data storage, and RxNorm lookups.
- **PostgreSQL database** — system-of-record for all patient data, schema designed to map cleanly to FHIR resource fields (Section 4.4).
- **Object storage (S3)** — peristomal skin-condition photos (Section 3.2) and generated physician-view PDF exports (Section 3.5).
- **Push notification delivery** — for reminders (Section 3.4), via Expo's push notification service (built on APNs/FCM), invoked by the backend on a schedule.
- **Admin console** (React SPA, internal-only) — manages clinical value sets, default range tables, and validation thresholds (Section 3.11). Deployed separately from the patient web app, backed by its own identity pool, with no API route to PHI.
- **Identity provider** — issues and validates OAuth 2.0/OIDC tokens for both patient clients (and, via a separate pool, for admin users); backs biometric login on mobile by unlocking a securely stored refresh token (device Keychain/Keystore via Expo SecureStore) rather than storing biometric data itself.

```
[Mobile App] --local SQLite--> (offline-capable)
     |  sync (REST, delta + conflict resolution)
     v
[Backend API (Node/TS)] <--REST (online-only)-- [Web App (React SPA)]
     ^
     +--REST /api/v1/admin (no PHI routes)-- [Admin Console (React SPA, internal)]
     |
     +--> [PostgreSQL] (FHIR-shaped schema)
     +--> [S3] (photos, PDF exports)
     +--> [Identity Provider] (OAuth2/OIDC, MFA)
     +--> [RxNorm API] (medication terminology lookups)
     +--> [Expo Push Service] --> [APNs / FCM] --> mobile devices
```

### 4.2 Frontend Architecture
- **Mobile:** Expo (managed workflow) + React Native + TypeScript. Local persistence via `expo-sqlite`. Shared UI components and business logic consumed from `packages/ui` and `packages/core` (Section repo layout).
- **Web:** React + TypeScript, built with Vite, served as a static single-page app. Shares `packages/ui` components with mobile where feasible (e.g. via React Native Web), and shares validation/business logic and FHIR-mapping types from `packages/core` directly (no local database to bridge).
- **Admin console:** React + TypeScript + Vite — the same toolchain as the web app, deployed as a separate static SPA against an isolated `/api/v1/admin/...` surface. It shares presentational primitives from `packages/ui` but imports no patient data types, so there is no code path through which patient records could be rendered.
- **State/data layer:** a typed API client generated from the backend's OpenAPI schema, shared as part of `packages/core`, used by both clients — keeps request/response shapes in sync with the backend automatically as the API evolves.

### 4.3 Backend Architecture
- **Language/framework:** Node.js + TypeScript. Recommend a structured framework (e.g. NestJS) over a minimal one (Express/Fastify) given the compliance requirements in Section 5.2 — NestJS's module/guard/interceptor patterns map naturally onto cross-cutting concerns like RBAC enforcement, audit logging, and request validation, which every endpoint touching PHI needs. This specific framework choice can be revisited during initial scaffolding without affecting the rest of this architecture.
- **API style:** RESTful JSON API, versioned via URL prefix (`/api/v1/...`). REST was chosen over GraphQL for this scope — the data shapes are well-defined and resource-oriented (which also maps naturally to FHIR's own resource style), and REST keeps the API surface simpler to secure, audit, and rate-limit endpoint-by-endpoint.
- **Authentication:** OAuth 2.0/OIDC via the identity provider (Section 4.6), issuing short-lived JWT access tokens + rotating refresh tokens. MFA enforced at the identity-provider level for password-based flows (Section 5.2).
- **ORM/data access:** a typed ORM (e.g. Prisma) against PostgreSQL, giving compile-time-checked queries and a migration history — important for an auditable, schema-evolving healthcare data store.
- **External provider abstraction (Phase 4):** the identity provider, object store, and push-delivery service are consumed through configuration and adapters rather than through AWS-specific clients embedded in request handling. The API accepts a standard OIDC issuer, JWKS URI, audience, and claim mapping rather than importing a Cognito SDK; it accepts an S3 endpoint, region, credentials, and path-style addressing flag rather than assuming AWS-hosted S3. This is what allows the development environment (Section 4.9) to run with no AWS dependency at all while remaining structurally identical to staging and production. Without it, development and production diverge in code rather than in configuration, and the difference surfaces only at staging.

### 4.4 Data Model & Interoperability Strategy
*(supersedes v1.0 Section 4, reflecting the Phase 3 decision to use PostgreSQL with a FHIR-shaped schema rather than a managed FHIR-native store)*
- **Clinical tables** (stoma output, fluid intake, medication administration) are modeled as relational tables whose columns map 1:1 to FHIR R4 fields — e.g. an `observations` table carries `value_quantity`, `unit`, `effective_datetime`, and `method` columns directly corresponding to `Observation.valueQuantity`, `Observation.effectiveDateTime`, and `Observation.method`.
- **Method attribute:** the "Estimated vs. Measured" flag (Section 3.1) is stored as an explicit `method` column, populated with the appropriate SNOMED CT code for "Estimation technique" when applicable — carried forward unchanged from v1.0.
- **Medication data:** stored using RxNorm RXCUIs (carried forward from v1.0), in a `medication_administrations` table separate from the generic observations table, reflecting that medications are a distinct FHIR resource type (`MedicationAdministration`) from `Observation`.
- **App-native tables** (appliance changes, leak events, peristomal skin condition, reminder configuration, Quick-Add templates — all Phase 1 additions) are modeled as ordinary relational tables without FHIR constraints, since they don't correspond to standard FHIR resources. This is the main trade-off of the Postgres-with-FHIR-shaped-schema approach versus a managed FHIR-native store: full flexibility for these app-specific data types, at the cost of the database not being FHIR-native itself.
- **Urine observations (Phase 4):** voided urine (Section 3.7) is stored in the same `observations` table as other volumetric entries, distinguished by its observation code, so it inherits the FHIR `Observation` mapping and the Measured/Estimated `method` column unchanged. Optional urine color is stored as a coded observation component rather than a free-text field, so it is analyzable and value-set governed.
- **Weight observations (Phase 5):** body weight (Section 3.12) is stored in the `observations` table alongside other measurements, distinguished by its observation code, and maps to FHIR R4 `Observation` in the standard way. The `method` column is left unpopulated, since the Measured/Estimated distinction does not apply to a scale reading. The computed rolling baseline is derived rather than stored as an observation; a physician-set target dry weight is stored as a range value with provenance, like any other target.
- **Observation code system:** clinical observation codes use **LOINC** (body weight is LOINC 29463-7), with SNOMED CT retained for the `method` attribute as specified above. This was implicit before Phase 5 and is stated here explicitly, since weight is the first entry type with an unambiguous, universally recognized standard code.
- **Configuration tables (Phase 4):** clinical value sets, default range tables, and validation thresholds (Section 3.11) are configuration, not patient data, and live in their own tables outside the PHI boundary. Value-set members carry an active/retired status and are never hard-deleted; clinical records reference them by stable code, so a retired member still resolves when rendering historical entries.
- **Suggested vs. effective ranges (Phase 4):** a patient's effective range is stored with its provenance — physician-set, patient-set, patient-confirmed suggestion, or clinical default (Section 3.9 precedence) — so the physician view can show not just the threshold but where it came from, and so an unconfirmed suggestion is never mistaken for a clinical target.
- **FHIR export:** a dedicated export module in the backend assembles valid FHIR R4 `Bundle` resources on demand — from the FHIR-mappable tables — for the physician-view share-link/PDF export (Section 3.5) and for any future EHR integration, rather than the database storing FHIR resources natively.

### 4.5 Data Synchronization & Offline Architecture
- **Scope:** offline-first applies to the mobile app only (Phase 3 decision); the web app requires connectivity.
- **Local write path:** every mobile data-entry action writes immediately to local SQLite and is also appended to a local `sync_queue` table (operation type, entity, payload, client-generated UUID, client timestamp).
- **Sync trigger:** on connectivity restore (and periodically in the foreground), the app pushes queued operations to the backend in timestamp order via a sync endpoint.
- **Conflict resolution:** last-write-wins by timestamp (Section 5.3), applied server-side; a losing write is not discarded but recorded in the audit log (Section 5.2) with both versions, so the patient's data history stays complete even when auto-resolved.
- **Pull sync:** the backend exposes a delta endpoint (`updated_since` cursor) so the mobile app can pull down out-of-band changes (e.g., a physician-set target range updated through a future portal) without re-fetching the full dataset.

### 4.6 Infrastructure & Hosting (AWS)
- **Compute:** the API runs as a containerized service on AWS Fargate (ECS) — avoids managing servers directly while suiting a stateful, always-on Node.js API better than a function-per-endpoint Lambda model would.
- **Database:** Amazon RDS for PostgreSQL, Multi-AZ, sized to support the Section 5.3 uptime and RPO/RTO targets (Multi-AZ failover plus RDS automated backups).
- **Object storage:** Amazon S3, server-side encrypted (SSE-KMS), for skin-condition photos and generated PDF exports; access via short-lived presigned URLs rather than public buckets.
- **Web app hosting:** the React SPA build is served as static assets via S3 + CloudFront.
- **Identity:** Amazon Cognito as the OAuth2/OIDC identity provider — AWS-native, HIPAA-eligible under a BAA, and reduces custom-built auth/security surface area compared to a self-hosted identity service.
- **Identity (admin, Phase 4):** a Cognito user pool entirely separate from the patient pool. Admin and patient credentials are disjoint — an admin token cannot address a patient endpoint and a patient token cannot address the admin API — so the Section 3.11 zero-PHI boundary is enforced at the identity layer rather than resting solely on application authorization logic. MFA is mandatory for all admin accounts.
- **Admin console hosting (Phase 4):** static assets via S3 + CloudFront like the patient web app, but network-restricted (private distribution or IP allowlist) rather than openly internet-facing.
- **Secrets & keys:** AWS Secrets Manager for credentials/API keys, AWS KMS for encryption key management and rotation (Section 5.2).
- **Networking:** API and database run in a private VPC subnet; only the load balancer/API Gateway edge is internet-facing.
- **BAA coverage:** a Business Associate Agreement must be executed with AWS covering every HIPAA-eligible service actually used (RDS, S3, Fargate/ECS, Cognito, KMS, Secrets Manager) before any real PHI is stored — a legal/compliance action item, not an engineering one.

### 4.7 CI/CD & Environments
- **CI/CD:** GitHub Actions (already scaffolded under `.github/workflows/`) — lint, type-check, and test on every pull request using GitHub-hosted runners; separate deploy workflows per app (`apps/mobile` via Expo/EAS Build, `apps/web` and `apps/api` via container/static-asset deploys to AWS). The development environment deploys via a **self-hosted runner** on the on-premise host (Section 4.9), which connects outbound to GitHub so the server needs no inbound network access.
- **Infrastructure as code:** AWS CDK (TypeScript) — keeps infrastructure definitions in the same language as the rest of the monorepo.
- **Environments:** three environments, of which only two are on AWS.
  - **Development** — on-premise, containerized, no AWS dependency (Section 4.9).
  - **Staging** — a separate AWS account mirroring production topology. Because development deliberately forgoes orchestration, TLS, and identity-provider parity, staging is the **parity gate**: it is the first environment where Fargate behavior, real Cognito, TLS, and KMS are exercised, and it must be designed against the deferred-risk list in `docs/deployment-development.md`.
  - **Production** — a separate AWS account, and the only environment permitted to hold real PHI.
  Synthetic or de-identified data is used in development and staging. Development is not eligible for real PHI under any circumstance, including bug reproduction.

### 4.8 Observability & Monitoring
- **Logging & metrics:** Amazon CloudWatch for backend application logs, infrastructure metrics, and alarms (feeding the Section 5.3 uptime target).
- **Error tracking:** a cross-platform error-tracking tool (e.g. Sentry) across mobile, web, and backend, so client-side failures (including sync failures) are visible, not just backend errors.
- **Audit log storage:** the Section 5.2 PHI audit log is written to its own append-only table/store, separate from general application logs, with restricted access consistent with least-privilege RBAC.


### 4.9 Development Environment
*(Phase 4)*
Development deliberately does not run on AWS. It is a single shared, fully containerized stack under Docker Compose on an on-premise Ubuntu LTS server: the API, PostgreSQL, MinIO in place of S3, a mock OIDC provider in place of Cognito, and both SPAs served as static builds. Access is LAN-only over plain HTTP, with synthetic data only, deployed by a self-hosted GitHub Actions runner connecting outbound so no inbound network access is required. Database state persists across deploys, migrations run automatically, and a scenario-based generator seeds correlated clinical data — correlated because the physician view (Section 3.5), anomaly flagging, and range adaptation (Section 3.9) cannot be exercised by uncorrelated random values.

This buys fast, self-contained iteration with no cloud spend, no BAA exposure, and no dependency on connectivity. It costs orchestration, TLS, and identity-provider parity, which become staging's responsibility per Section 4.7.

Two consequences are architectural rather than operational and are specified in Section 4.3: the OIDC issuer and the object-storage endpoint must both be configuration.

Full methodology — image build strategy for the pnpm monorepo, deployment pipeline, database lifecycle, seed scenarios, host baseline, and the explicit list of risks deferred to staging — is in `docs/deployment-development.md`.

## 5. Non-Functional Requirements
*(Phase 2 — approved 2026-09-04)*

### 5.1 Performance & Responsiveness
Kept qualitative for v1; concrete numeric targets (e.g., p95 save latency, cold-start time) should be added once initial technical spikes establish a realistic baseline for the chosen stack (Phase 3).
- Data-entry actions (logging output, intake, meals, medications, appliance changes) must feel instantaneous — no perceptible lag between tapping "Save" and the UI confirming the entry, regardless of network connectivity, enabled by the offline-first local-write architecture (Section 2).
- Quick-Add widget taps (Section 3.1) must resolve immediately, without a loading state.
- Dashboard and history views (Section 3.6) must load without noticeable delay when browsing typical date ranges (e.g., 30–90 days).
- Background sync must be transparent and must never block or visibly interfere with foreground data entry.
- The physician-focused view (Section 3.5), including its chart overlays, must feel responsive when switching time-period filters or date ranges.
- **Follow-up:** revisit this section post-spike to convert these directional statements into testable numeric targets.

### 5.2 Security & Compliance
Carries forward and expands the v1.0 HIPAA baseline into a full compliance program.

*Carried forward from v1.0:*
- Encryption of PHI at rest and in transit (TLS 1.3+).
- Secure authentication (OAuth 2.0 / OpenID Connect) with biometric login support on mobile, and MFA for password reset.
- Automated session timeouts.
- Executed Business Associate Agreements (BAAs) with all cloud providers handling PHI.

*New for v2:*
- **Audit Logging:** All create/edit/delete actions on PHI — including the Section 3.6 entry-correction audit trail — are logged with user identity, timestamp, and before/after values, and retained per the data-retention policy below.
- **Role-Based Access Control (RBAC):** Defined roles with least-privilege access. For v1, patient data is accessible only to the patient by default, consistent with the Phase 1 decision to keep care-team access to a one-off export/share-link (Section 3, Appendix A) rather than a standing care-team role.
- **Data Retention & Deletion Policy:** A defined retention period for PHI, and a patient-initiated account/data deletion process with a defined completion SLA and clear disclosure of what is deleted vs. retained for legal/audit purposes. *Exact retention period and deletion SLA to be finalized with legal/compliance counsel — not set arbitrarily in this spec.*
- **Breach Notification Process:** A documented incident-response and breach-notification procedure consistent with the HIPAA Breach Notification Rule, owned by a designated Security/Privacy Officer role.
- **Periodic Penetration Testing & Vulnerability Scanning:** Third-party penetration testing at a defined cadence (e.g., annually and after major architecture changes), plus continuous automated dependency/vulnerability scanning in CI.
- **Secrets & Key Management:** Managed secrets store (never committed to source control); defined encryption key rotation policy.
- **Administrative Configuration Audit (Phase 4):** All administration console changes to value sets, default range tables, and validation thresholds are logged with admin identity, timestamp, and before/after values in the same append-only audit store as PHI actions. These settings determine clinical thresholds and the terminology patients are shown, so they carry audit rigor equivalent to PHI edits despite containing no PHI themselves.
- **Third-Party Terminology Compliance:** Confirm RxNorm and SNOMED CT usage (Sections 3.3, 4) complies with their respective license terms as part of legal review.

### 5.3 Availability & Reliability
Concrete targets, to be revisited once actual infrastructure/hosting is selected in Phase 3.
- **Backend/API Uptime:** Target 99.9% monthly uptime (~43 minutes of budgeted downtime/month).
- **Backup & Disaster Recovery:** Automated daily backups of the central database; Recovery Point Objective (RPO) ≤ 24 hours; Recovery Time Objective (RTO) ≤ 4 hours for full service restoration.
- **Offline Sync Conflict Resolution:** Default rule is last-write-wins by timestamp. The losing version is retained in the Section 5.2 audit trail rather than silently discarded, so no data is truly lost even when a conflict is auto-resolved.
- **Offline Data Durability:** Locally cached data must survive app restarts and OS-level background termination; sync resumes automatically without user intervention once connectivity returns.
- **Graceful Degradation:** If the backend is unreachable, all local logging, history, and reminders functionality continues to work; only physician-view sharing and cross-device profile sync require connectivity.

### 5.4 Usability & Accessibility
Ostomy patients skew older and post-surgical, which raises the stakes for accessible, plain-language design.
- **WCAG 2.1 Level AA** compliance target across mobile and web: color contrast, screen-reader (VoiceOver/TalkBack) support, scalable text, and minimum touch-target sizes — particularly relevant given patients may have reduced dexterity post-surgery.
- **Plain-Language / Health-Literacy Standard:** Patient-facing copy written at approximately a 6th–8th grade reading level (consistent with CDC/NIH plain-language guidance). Clinical terms (e.g., RxNorm medication names) are paired with patient-friendly labels, consistent with the Section 3.3 terminology-mapping requirement.
- **Language Scope for v1:** English-only at launch.
- **Localization-Ready Architecture:** Although v1 ships English-only, all UI copy must be externalized (no hardcoded strings in code) and the app must use locale-aware date/time/number/unit formatting from day one, so additional languages (e.g., Spanish) can be added later without structural rework. Carried into the Phase 3 Technical Architecture discussion (choice of i18n library, translation-key management).
- **Pre-Launch Usability Review:** Given the target population, a usability/accessibility review with representative patients should occur before launch, not just automated WCAG scanning.

## 6. User Stories

### Epic 1: Authentication, Security & HIPAA Compliance
- As a user, I want to securely log in using biometric authentication (FaceID/TouchID) on my mobile device so that I can access my diary quickly without compromising my health data.
- As a user, I want my active session to automatically time out after a period of inactivity so that my health information remains secure if I leave my device unattended.
- As a system administrator, I need all Protected Health Information (PHI) to be encrypted at rest and in transit so that the application fully complies with HIPAA standards.
- As a user, I want to be able to reset my password securely using a multi-factor authentication (MFA) process so that I can regain access to my account safely.

### Epic 2: Data Entry & Logging (Intake, Output, & Meals)
- As a patient, I want to log my stoma output volume in exact milliliters (mL) so that I can accurately track my fluid loss.
- As a patient, I want to toggle a flag indicating whether my logged output was "Measured" or "Estimated" so that my physician understands the precision of the data point.
- As a patient, I want to log my daily fluid intake in milliliters (mL) so that I can track my hydration against my output.
- As a patient, I want to log the meals I eat, including a timestamp, so that I can see how specific foods affect my stoma output later in the day.
- As a data architect, I need the database to store output and intake logs in a structure mapped to the HL7 FHIR Observation resource so that the data is ready for future EHR integration.

### Epic 3: Smart Dashboard & Quick-Add Widgets
- As a patient, I want the dashboard to display dynamic "Quick-Add" widgets based on my most frequent recent entries so that I can log routine events with a single tap.
- As a patient, I want the ability to tap a Quick-Add widget and open it as a draft so that I can make minor adjustments to the pre-filled data before saving.
- As a patient, I want to set custom default values for my standard cup sizes or usual fluid intakes so that I can chart by exception.

### Epic 4: Medication Management & Terminology
- As a patient, I want to search for medications using common, patient-friendly terms so that I can easily find and log the correct symptom-management medication.
- As a system architect, I want the medication search function to map patient selections to backend RxNorm Concept Unique Identifiers (RXCUIs).
- As a patient, I want to log the precise time I administered a medication so that its effect on my subsequent stoma output can be tracked.

### Epic 5: The Physician-Focused View & Reporting
- As a physician, I want to view a calculated "Daily Net Fluid Balance" (total intake minus total output) so that I can instantly assess a patient's risk of dehydration.
- As a physician, I want to view a chronological visual overlay showing stoma output spikes plotted against fluid intake and medication administration times.
- As a physician, I want the report to automatically highlight data anomalies (e.g., output exceeding 1,000 mL/day) so that I can focus immediately on actionable clinical risks.
- As a patient, I want to generate a secure, read-only link or PDF export of the physician-focused view so that I can easily share my latest data during a clinic visit.

### Epic 6: Offline-First Architecture & Synchronization
- As a patient, I want to log my output and meals even when my device has no internet connection so that my tracking remains uninterrupted.
- As a patient, I want to view my recent historical data and dashboard widgets while offline so that I can reference my daily progress anywhere.
- As a system, I need to automatically detect when network connectivity is restored and sync locally cached data to the secure cloud server so that the central database is always up to date.

### Epic 7: Onboarding & Profile Setup — NEW
- As a new patient, I want to select my ostomy type during onboarding so the app applies clinically appropriate default output ranges.
- As a patient, I want to enter my physician's target ranges so anomaly flags reflect my actual care plan rather than generic population defaults.
- As a patient, I want to choose metric or imperial once so every volume and weight in the app matches how I think about measurement.
- As a newly discharged patient, I want to start logging after answering only a few essential questions so I can begin tracking immediately and finish setup later.

### Epic 8: Appliance & Peristomal Skin Health Tracking — NEW
- As a patient, I want to log each appliance change with a timestamp so the app can track my average wear time.
- As a patient, I want to log a leak when it happens, including severity, so I can identify patterns (e.g., foods or activities that precede leaks).
- As a patient, I want to record the condition of my peristomal skin at each appliance change so I can track irritation trends and share them with my care team.
- As a physician, I want to see appliance wear-time and leak-frequency trends alongside skin-condition entries so I can assess whether the current appliance or care plan needs adjustment.

### Epic 9: Reminders & Notifications — NEW
- As a patient, I want a reminder at my usual appliance-change time so I don't experience unplanned leaks.
- As a patient, I want medication reminders so I don't miss doses that manage my symptoms.
- As a patient, I want to be nudged when my fluid intake is trending low relative to my output so I can proactively rehydrate.
- As a patient, I want to control which reminder types are on and set quiet hours so notifications don't disrupt my sleep or work.

### Epic 10: Data Management & History — NEW
- As a patient, I want to correct a mis-logged entry after the fact so my records stay accurate, while the system retains an audit trail for clinical trustworthiness.
- As a patient, I want to filter my history by category so I can review just my medication or output log.
- As a patient, I want to export my full history for my own records, separate from the physician summary.

### Epic 11: Non-Functional Requirements — NEW
- As a security/privacy officer, I need every PHI create/edit/delete action logged with user identity and before/after values so the app is auditable and compliant.
- As a patient, I want the app to keep working for logging and viewing history even when I have no signal, so travel or poor connectivity never blocks my care tracking.
- As a patient using a screen reader, I want the app to be fully navigable and readable so I can manage my care independently.
- As a product owner, I need a documented breach-notification process and a defined backup/recovery target (RPO/RTO) so the organization can respond correctly to an incident.

### Epic 12: Urine Output & Hydration Tracking — NEW
- As a patient, I want to log the urine I pass so my care team can see whether I am staying adequately hydrated, not just how much is coming out of my stoma.
- As a patient, I want to record a urine color instead of a volume when I cannot measure, so I can still capture a hydration signal without a measuring container.
- As a physician, I want urine output shown as its own indicator rather than merged into net fluid balance, so a low urine output cannot be hidden by a normal-looking balance figure.
- As a patient, I want to see my urine output trend against my expected range so I can tell when I need to drink more.

### Epic 13: Data Validation — NEW
- As a patient, I want the app to stop me from saving an impossible entry, such as a negative volume or a date before my surgery, so my record stays trustworthy.
- As a patient, I want an unusual but real value to give me a confirmation prompt rather than a refusal, so the app never prevents me from recording what actually happened.
- As a patient logging offline, I want the same validation feedback immediately, so I do not discover a problem with an entry days later when it finally syncs.
- As a system, I need every validation rule re-checked server-side on write and on sync, so data arriving from a device is never trusted on the client's word alone.
- As a clinical administrator, I want validation thresholds to be configuration rather than code, so a threshold can be adjusted without an engineering release.

### Epic 14: Suggested Ranges — NEW
- As a new patient, I want the app to suggest a sensible intake goal and expected output range for my ostomy type and time since surgery, so I am not asked to invent clinical numbers I have no basis to choose.
- As a patient, I want to see plainly why a value was suggested and be able to change it, so I understand and control what my app is measuring me against.
- As a patient, I want to be told when the app wants to adjust a range based on my own history, so a shifting baseline never quietly changes what counts as normal for me.
- As a physician, I want my entered target to override any suggestion and never be silently changed, so my care plan remains the governing value.

### Epic 15: Preference Management — NEW
- As a patient, I want one place to change my units, targets, reminders, and accessibility settings so I do not have to hunt through the app.
- As a patient, I want to switch between mL and oz and see my whole history re-rendered in that unit, so my past data stays meaningful to me.
- As a patient, I want to manage or remove Quick-Add widgets so my dashboard reflects my current routine rather than an old one.
- As a patient, I want my preferences to follow me across devices so I do not have to configure the app twice.

### Epic 16: Administration Console — NEW
- As a clinical administrator, I want to manage the value sets the app offers, such as output consistency options, so terminology can be corrected without a code release.
- As a clinical administrator, I want to retire a value rather than delete it, so historical patient entries that used it still display correctly and their meaning never changes.
- As a clinical administrator, I want to maintain the default range tables that seed patient suggestions, so clinical guidance can be updated centrally.
- As a security officer, I need the admin console to have no access path to patient data whatsoever, so it stays outside PHI scope by design.
- As a security officer, I need every administrative configuration change audit-logged with identity and before/after values, so clinical threshold changes are as traceable as PHI edits.

### Epic 17: Weight Tracking & Hydration Status — NEW
- As a patient, I want to log my weight so changes that signal fluid loss are caught even when my intake and output logging is incomplete.
- As a patient, I want a daily reminder to weigh in so my readings are consistent enough to mean something.
- As a patient, I want to be told in plain terms when my weight has dropped meaningfully, and what to do about it, so I can act before I become seriously dehydrated.
- As a patient, I want one clear hydration status on my dashboard rather than three separate numbers to interpret, while still being able to see what is behind it.
- As a physician, I want net fluid balance, urine output, and weight shown separately so I can tell which signal actually moved.
- As a patient, I want weight presented as a hydration measure rather than a weight-management metric, and I want to be able to turn it off entirely.
- As a patient whose weight is legitimately recovering after surgery, I want my baseline to track that recovery so normal regain is not flagged as a problem.

## 7. Detailed Acceptance Criteria

Acceptance criteria below cover Epic 2 (Data Entry), carried forward in full from v1.0 — the only epic v1.0 detailed to this level — plus Epics 12–14, added in Phase 4 because urine logging, validation, and suggested ranges are defined largely by their rules and are ambiguous without them, and Epic 17, added in Phase 5. Acceptance criteria for Epics 3–11, 15, and 16 are not yet written and remain a backlog-refinement task.

### User Story 2.1: Log Stoma Output Volume

**AC 1: Numeric Validation**
- Given the user is on the "Add Output" screen,
- When they enter a value into the Volume field,
- Then the field must only accept positive integers (no decimals or negative numbers).

**AC 2: Out-of-Bounds Error Handling**
- Given the user is entering an output volume,
- When the user inputs a value greater than 2,000 mL,
- Then the system will display a soft warning prompt: "This is a high volume for a single entry. Please confirm this amount is correct," before allowing the user to save.

**AC 3: Timestamp Editing**
- Given the user is logging an output event,
- When the screen loads,
- Then the Date and Time fields auto-populate with the current system time, but remain fully editable so the user can backdate an entry.

### User Story 2.2: The "Measured vs. Estimated" Flag

**AC 1: Mandatory Selection**
- Given the user has entered a volume on the "Add Output" screen,
- When they attempt to tap "Save" without selecting an entry method,
- Then the system prevents saving and highlights the "Measured / Estimated" toggle group with a required field error.

**AC 2: Visual Differentiation in History**
- Given the user is viewing their daily log history,
- When an output entry is displayed,
- Then it must contain a clear visual indicator (e.g., an icon or badge) denoting whether that specific volume was Estimated or Measured.

### User Story 2.3: Log Fluid Intake

**AC 1: Fluid Type Categorization**
- Given the user is logging fluid intake,
- When they enter the volume,
- Then they must be presented with an optional categorized dropdown/list for the type of fluid (e.g., Water, ORS, Coffee/Tea, Juice) to aid in dietary trigger analysis.

**AC 2: Quick-Add Standard Sizes**
- Given the user is on the "Add Intake" screen,
- When they view the volume input section,
- Then they see at least three configurable quick-select buttons for standard container sizes (e.g., 250 mL glass, 500 mL bottle) that auto-fill the volume field when tapped.

### User Story 2.4: Log Meals

**AC 1: Text Entry & Tagging**
- Given the user is on the "Add Meal" screen,
- When logging food,
- Then they can use a free-text area to describe the meal AND select from optional quick-tags (e.g., High Fiber, Dairy, High Sugar).

**AC 2: Meal Size Estimation**
- Given the user is logging a meal,
- When saving the entry,
- Then they must select a relative size modifier (Small/Snack, Medium/Standard, Large/Heavy).

### User Story 2.5: FHIR Mapping Readiness

**AC 1: JSON Payload Structure**
- Given an output or intake record is saved,
- When the API receives the payload,
- Then the data must be stored with keys mapping directly to FHIR R4 standard fields (e.g., `resourceType: "Observation"`, `valueQuantity.value`).

**AC 2: Method Attribute Mapping**
- Given a user saves an output entry marked as "Estimated",
- When the database writes the record,
- Then it must correctly populate the FHIR `Observation.method` attribute using the appropriate SNOMED CT code for "Estimation technique".

### User Story 12.1: Log Voided Urine

**AC 1: Same Entry Contract as Other Volumes**
- Given the user is on the "Add Urine" screen,
- When they enter a volume,
- Then the field accepts a volume in the user's preferred unit and requires the same Measured/Estimated selection as output and intake entries, enforced identically.

**AC 2: Color Without Volume**
- Given the user cannot measure a volume,
- When they log a urine entry,
- Then they may save a color-scale value with no volume, and the entry is retained as a valid hydration observation.

**AC 3: Color Is Not Conveyed by Color Alone**
- Given the user is selecting a urine color,
- When the color scale is displayed,
- Then each step carries a visible text label in addition to its swatch, and is announced distinguishably by a screen reader.

**AC 4: Excluded From Net Fluid Balance**
- Given a patient has logged both stoma output and voided urine for a day,
- When the Daily Net Fluid Balance is calculated,
- Then voided urine is excluded from the total output term, and urine output is displayed as a separate hydration indicator.

### User Story 13.1: Hard-Block Validation

**AC 1: Structurally Invalid Input Cannot Be Saved**
- Given the user enters a negative or non-numeric volume,
- When they attempt to save,
- Then the system blocks the save and explains which value is invalid, in plain language.

**AC 2: Timestamp Bounds**
- Given the user edits an entry's date and time,
- When they set a time in the future beyond the permitted clock-skew allowance, or a time earlier than their recorded surgery date,
- Then the system blocks the save and states the permitted range.

**AC 3: Server-Side Re-Enforcement**
- Given an operation reaches the API, whether from a live client or a queued offline sync,
- When the server processes it,
- Then every Tier 1 rule is evaluated again server-side, and a failing operation is rejected regardless of having passed client-side validation.

**AC 4: Rejected Sync Operations Are Not Lost**
- Given a queued offline operation is rejected by server-side validation,
- When the sync completes,
- Then the operation is retained locally and surfaced to the patient for correction rather than discarded silently.

### User Story 13.2: Soft-Warning Validation

**AC 1: Warning Is Always Overridable**
- Given the user enters a volume above the configured soft-warning threshold,
- When they attempt to save,
- Then the system shows a confirmation prompt describing what looks unusual, and saving proceeds unchanged if the user confirms.

**AC 2: Thresholds Are Configuration**
- Given an administrator changes a soft-warning threshold in the administration console,
- When a patient next logs an entry,
- Then the new threshold governs the warning, with no application release required.

### User Story 14.1: Suggested Range Presentation

**AC 1: Pre-Filled With Stated Basis**
- Given a patient reaches a target-range field during onboarding or in preferences,
- When the field is displayed,
- Then it is pre-filled with the suggested value and accompanied by a plain-language statement of its basis, including ostomy type and time since surgery.

**AC 2: Confirmation Required to Become a Threshold**
- Given a suggested range has not been confirmed by the patient,
- When anomaly detection runs,
- Then the unconfirmed suggestion is not applied as an anomaly threshold, and the stored range records its provenance.

**AC 3: Adaptation Is Proposed, Never Silent**
- Given enough history exists to refine a patient's range,
- When the app determines an adjustment is warranted,
- Then it presents the proposed change with its rationale and applies it only on patient acceptance.

**AC 4: Physician-Set Values Are Protected**
- Given a target range was set by a physician,
- When the app computes a refined suggestion that differs from it,
- Then the physician-set value remains in force and the divergence is flagged rather than applied.

### User Story 17.1: Log Weight

**AC 1: Units Follow the Measurement System**
- Given the patient has selected a measurement system,
- When they log a weight,
- Then the entry is captured in kg for metric or lb for imperial, to one decimal place, and no mixed-system combination is selectable.

**AC 2: No Measured/Estimated Toggle**
- Given the patient is logging a weight,
- When the entry screen is displayed,
- Then no Measured/Estimated selection is presented or required, unlike volumetric entries.

**AC 3: Implausible Change Warns Rather Than Blocks**
- Given the patient enters a weight that differs from their previous reading by more than the configured day-over-day threshold,
- When they attempt to save,
- Then a soft warning asks them to confirm, and saving proceeds unchanged on confirmation.

**AC 4: Absolute Physiological Bounds Are Enforced**
- Given the patient enters a weight outside the configured absolute plausible range,
- When they attempt to save,
- Then the save is blocked as a Tier 1 validation failure.

### User Story 17.2: Baseline and Significant Change

**AC 1: Baseline Tracks Legitimate Recovery**
- Given a patient's weight has risen steadily over months of post-operative recovery,
- When the rolling baseline is recomputed,
- Then it follows the recovered weight, and the sustained gain is not flagged as an anomaly.

**AC 2: Physician-Set Dry Weight Takes Precedence**
- Given a physician-set target dry weight exists,
- When change is evaluated,
- Then it is measured against that value rather than the computed rolling baseline.

**AC 3: Time-of-Day Mismatch Is Not Treated as Change**
- Given two readings taken at substantially different times of day,
- When they are compared,
- Then the comparison is noted as spanning inconsistent conditions rather than being presented as an unqualified change.

**AC 4: Change Is Expressed Absolutely to the Patient**
- Given a significant weight change has been detected using a percentage threshold,
- When the patient is notified,
- Then the message states the change in kg or lb, not as a percentage of body weight, and includes plain-language guidance on increasing fluids and contacting their care team.

### User Story 17.3: Hydration Status Presentation

**AC 1: Composite on the Patient Dashboard**
- Given the patient has logged intake, output, urine, and weight,
- When they view the dashboard,
- Then a single plain-language hydration status is displayed, and the contributing signals are reachable from it.

**AC 2: Separate in the Physician View**
- Given the same data,
- When the physician-focused view is generated,
- Then net fluid balance, urine output, and weight appear as three distinct signals and are not combined into a score.

**AC 3: Status Is Always Explainable**
- Given a hydration status is shown,
- When the patient inspects it,
- Then the signal that drove the status is identifiable and its underlying readings are reachable.

**AC 4: Disabling Weight Removes It Cleanly**
- Given the patient turns off weight tracking in preferences,
- When the dashboard and reminders are next evaluated,
- Then the weigh-in reminder stops, weight is excluded from the composite status, and previously logged weights remain in history.


---
