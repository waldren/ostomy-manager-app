# Software Requirements Specification — Ostomy Patient Management Application (v2.0)

Prepared by: Steven E. Waldren, MD, MS
Supersedes: `Ostomy_App_Specification_v1.pdf` (v1.0), which is retained only as a historical reference — this document is fully self-contained and does not require consulting the v1.0 PDF.
Status: all three discussion phases complete.

| Phase | Topic | Status |
|---|---|---|
| 1 | User Functionality | ✅ Approved 2026-09-04 |
| 2 | Non-Functional Requirements (Performance, Security, Availability, Usability/Accessibility) | ✅ Approved 2026-09-04 |
| 3 | Technical Architecture | ✅ Approved 2026-09-04 |

Sections below are updated as each phase is completed. Sections not yet revisited are carried forward from v1.0 unchanged and marked as such.

---

## 1. Executive Summary & Product Vision
*(carried forward from v1.0, unchanged — may be revisited once Phase 3 is complete)*

This application is a dual-platform (Mobile & Web) patient-facing diary designed to help ostomy patients track and manage stoma output, fluid intake, meals, and medication administration. The primary market differentiator is its ability to seamlessly integrate input, output, and medication timing to inform both the patient and their healthcare providers on the efficacy of the current care plan. While version 1.0 operated as a standalone patient diary, the architecture is designed from day one to support future electronic health record (EHR) interoperability (via FHIR) and advanced AI/predictive capabilities.

## 2. Platforms & Accessibility
*(carried forward from v1.0, unchanged — accessibility requirements are now formally specified in Section 5.4)*

- **Cross-Platform Availability:** The application must be fully functional and accessible via a native/hybrid mobile application (iOS and Android) as well as a standard web browser.
- **Offline-First Architecture:** Because patients will track data on-the-go (e.g., in public restrooms or while traveling), the application must utilize a local database (e.g., SQLite or Realm) to allow continuous data entry and historical review without an active internet connection. Data will automatically synchronize with the central secure cloud server once connectivity is restored.

## 3. Core Features & Patient Workflows (User Functionality)
*(Phase 1 — approved 2026-09-04)*

### 3.0 Onboarding & Profile Setup — NEW
- **Ostomy Type Selection:** During onboarding, the patient selects their ostomy type (colostomy, ileostomy, or urostomy). This drives clinically appropriate default expected-output ranges rather than a one-size-fits-all baseline.
- **Surgery/Ostomy Creation Date:** Captured to contextualize the elevated-output risk typical of the early post-operative period.
- **Physician-Set Target Ranges:** The patient can enter (or a future physician portal can set) target ranges for daily output, net fluid balance, and anomaly thresholds. These personalize the anomaly-highlighting feature (Section 3.5) to the patient's actual care plan rather than generic population defaults. The patient may edit these, but edits that diverge from a physician-entered default are flagged.
- **Units Preference:** Patient selects mL or oz; all logging and display respect this preference.
- **Baseline Appliance Type:** Optional, seeds default appliance-change reminder cadence (Section 3.4).

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
- **Hydration/Intake Nudges:** Triggered when logged fluid intake trends low relative to output or the physician-set target.
- **Notification Preferences:** Independent enable/disable per reminder category; quiet-hours setting.

### 3.5 The Physician-Focused View (Care Plan Efficacy)
*(carried forward from v1.0, extended)*
- **Daily Net Fluid Balance:** Total fluid intake minus total stoma output (and other recorded losses), prominently displayed to highlight dehydration trends.
- **Chronological Correlation Visuals:** Data visualized across time periods (Morning, Afternoon, Evening, Night); line/bar graphs overlay medication administration times and fluid intake against stoma output volumes. **Extended:** appliance-change and skin-condition events are now overlaid on the same timeline so a physician can correlate a leak or irritation flare with intake/output/medication patterns.
- **Outlier & Anomaly Highlighting:** Automatically flags anomalies (e.g., output exceeding 1,000 mL/day while intake remains low), now using the patient's personalized target ranges from Section 3.0 where available, falling back to generic defaults otherwise.

### 3.6 Data Management & History — NEW
- **Edit/Delete Past Entries:** Patients can correct a mis-logged entry. The system retains an audit trail (original + corrected value) for clinical integrity — this also feeds into Section 5.2 (Security & Compliance) audit-logging requirements.
- **Filter/Search History:** By category (output, intake, meds, meals, appliance, skin).
- **Full History Export:** A complete personal-record export, distinct from the physician-summary export.

### Appendix A: Functionality Considered and Deferred
The following were discussed and deliberately excluded from v1/v2 scope, with rationale, so they remain a conscious decision rather than a silent omission:
- **Wearable integration** (Apple Health / Google Fit auto-logging of fluid intake or weight) — deferred; adds a full integration surface, better suited to a post-launch release.
- **Patient education/resource library** — deferred; this is content work rather than a data/workflow feature and can be scoped as its own initiative.
- **Gamification (streaks, badges)** — deferred; risks undercutting the clinical seriousness of the tool unless designed carefully.
- **Caregiver/provider portal accounts with ongoing live access** — deferred beyond the existing one-off read-only export/share-link; a full second user type is a materially larger scope and compliance surface.

## 4. Technical Architecture
*(Phase 3 — approved 2026-09-04)*

### 4.1 System Overview
- **Mobile app** (Expo/React Native, iOS + Android) — the primary offline-capable client. Writes to a local SQLite database first, then syncs to the backend when connectivity is available.
- **Web app** (React SPA) — online-only client (per Phase 3 scope decision); reads/writes go directly to the backend API, no local persistence layer beyond normal browser caching.
- **Backend API** (Node.js/TypeScript) — the single system of record; exposes a versioned REST API consumed by both clients; owns authentication, business logic, FHIR-shaped data storage, and RxNorm lookups.
- **PostgreSQL database** — system-of-record for all patient data, schema designed to map cleanly to FHIR resource fields (Section 4.4).
- **Object storage (S3)** — peristomal skin-condition photos (Section 3.2) and generated physician-view PDF exports (Section 3.5).
- **Push notification delivery** — for reminders (Section 3.4), via Expo's push notification service (built on APNs/FCM), invoked by the backend on a schedule.
- **Identity provider** — issues and validates OAuth 2.0/OIDC tokens for both clients; backs biometric login on mobile by unlocking a securely stored refresh token (device Keychain/Keystore via Expo SecureStore) rather than storing biometric data itself.

```
[Mobile App] --local SQLite--> (offline-capable)
     |  sync (REST, delta + conflict resolution)
     v
[Backend API (Node/TS)] <--REST (online-only)-- [Web App (React SPA)]
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
- **State/data layer:** a typed API client generated from the backend's OpenAPI schema, shared as part of `packages/core`, used by both clients — keeps request/response shapes in sync with the backend automatically as the API evolves.

### 4.3 Backend Architecture
- **Language/framework:** Node.js + TypeScript. Recommend a structured framework (e.g. NestJS) over a minimal one (Express/Fastify) given the compliance requirements in Section 5.2 — NestJS's module/guard/interceptor patterns map naturally onto cross-cutting concerns like RBAC enforcement, audit logging, and request validation, which every endpoint touching PHI needs. This specific framework choice can be revisited during initial scaffolding without affecting the rest of this architecture.
- **API style:** RESTful JSON API, versioned via URL prefix (`/api/v1/...`). REST was chosen over GraphQL for this scope — the data shapes are well-defined and resource-oriented (which also maps naturally to FHIR's own resource style), and REST keeps the API surface simpler to secure, audit, and rate-limit endpoint-by-endpoint.
- **Authentication:** OAuth 2.0/OIDC via the identity provider (Section 4.6), issuing short-lived JWT access tokens + rotating refresh tokens. MFA enforced at the identity-provider level for password-based flows (Section 5.2).
- **ORM/data access:** a typed ORM (e.g. Prisma) against PostgreSQL, giving compile-time-checked queries and a migration history — important for an auditable, schema-evolving healthcare data store.

### 4.4 Data Model & Interoperability Strategy
*(supersedes v1.0 Section 4, reflecting the Phase 3 decision to use PostgreSQL with a FHIR-shaped schema rather than a managed FHIR-native store)*
- **Clinical tables** (stoma output, fluid intake, medication administration) are modeled as relational tables whose columns map 1:1 to FHIR R4 fields — e.g. an `observations` table carries `value_quantity`, `unit`, `effective_datetime`, and `method` columns directly corresponding to `Observation.valueQuantity`, `Observation.effectiveDateTime`, and `Observation.method`.
- **Method attribute:** the "Estimated vs. Measured" flag (Section 3.1) is stored as an explicit `method` column, populated with the appropriate SNOMED CT code for "Estimation technique" when applicable — carried forward unchanged from v1.0.
- **Medication data:** stored using RxNorm RXCUIs (carried forward from v1.0), in a `medication_administrations` table separate from the generic observations table, reflecting that medications are a distinct FHIR resource type (`MedicationAdministration`) from `Observation`.
- **App-native tables** (appliance changes, leak events, peristomal skin condition, reminder configuration, Quick-Add templates — all Phase 1 additions) are modeled as ordinary relational tables without FHIR constraints, since they don't correspond to standard FHIR resources. This is the main trade-off of the Postgres-with-FHIR-shaped-schema approach versus a managed FHIR-native store: full flexibility for these app-specific data types, at the cost of the database not being FHIR-native itself.
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
- **Secrets & keys:** AWS Secrets Manager for credentials/API keys, AWS KMS for encryption key management and rotation (Section 5.2).
- **Networking:** API and database run in a private VPC subnet; only the load balancer/API Gateway edge is internet-facing.
- **BAA coverage:** a Business Associate Agreement must be executed with AWS covering every HIPAA-eligible service actually used (RDS, S3, Fargate/ECS, Cognito, KMS, Secrets Manager) before any real PHI is stored — a legal/compliance action item, not an engineering one.

### 4.7 CI/CD & Environments
- **CI/CD:** GitHub Actions (already scaffolded under `.github/workflows/`) — lint, type-check, and test on every pull request; separate deploy workflows per app (`apps/mobile` via Expo/EAS Build, `apps/web` and `apps/api` via container/static-asset deploys to AWS).
- **Infrastructure as code:** AWS CDK (TypeScript) — keeps infrastructure definitions in the same language as the rest of the monorepo.
- **Environments:** separate dev, staging, and production AWS environments/accounts, with production being the only environment permitted to hold real PHI; synthetic/de-identified data used in dev and staging.

### 4.8 Observability & Monitoring
- **Logging & metrics:** Amazon CloudWatch for backend application logs, infrastructure metrics, and alarms (feeding the Section 5.3 uptime target).
- **Error tracking:** a cross-platform error-tracking tool (e.g. Sentry) across mobile, web, and backend, so client-side failures (including sync failures) are visible, not just backend errors.
- **Audit log storage:** the Section 5.2 PHI audit log is written to its own append-only table/store, separate from general application logs, with restricted access consistent with least-privilege RBAC.


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
- As a patient, I want to set my preferred units (mL or oz) so all logging matches how I think about volume.

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

## 7. Detailed Acceptance Criteria

Acceptance criteria below cover Epic 2 (Data Entry), carried forward in full from v1.0 — the only epic v1.0 detailed to this level. Acceptance criteria for Epics 3–11 (including the Phase 1/2 additions) are not yet written and remain a backlog-refinement task, not part of this spec-revision discussion.

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


---
