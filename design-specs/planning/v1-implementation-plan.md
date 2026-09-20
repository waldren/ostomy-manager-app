# v1 Implementation Plan — Ostomy Patient Management Application

Status: active (revision 2, 2026-09-19) · Derived from `design-specs/requirements/SRS_v2.md` (v2.5) and the nineteen accepted ADRs in `design-specs/decisions/`

**Revision 2 exists because revision 1 stopped describing the repository.** Its "current state" section described a scaffolding-only repo that has since shipped P0, P1, P2 and half of P3; its decision table still listed items that are now accepted ADRs; and roughly a third of the merged commits since Gate B was written belong to no sprint in it. This revision re-baselines against what is actually built, folds the unowned work into named sprints and a tracked debt lane, and records four decisions taken on 2026-09-19 (§3.2).

**What did not change:** the phase structure after P3, the delegation model (§5), the cross-cutting table (§6), and every architecture decision in SRS §4. This is a re-baseline, not a redesign.

---

## 1. Objective

Sequence the remaining work from today's repository through complete v1, as bounded delegation units sized by reviewable diff.

**In scope:** the rest of the entry types and the configuration surface; onboarding, preferences and suggested ranges; history, physician view and exports; weight and composite hydration status; resting heart rate and concordance; the admin console; staging and production IaC; the compliance artifacts that gate production.

**Deliberately excluded:** everything in SRS Appendix A (urostomy, wearables, education library, gamification, live care-team portal accounts); a second locale; numeric performance targets, which SRS §5.1 defers until the spike (§4.4); and — new in this revision — **iOS** (§3.2, decision 1).

**No durations anywhere.** Sizing is S/M/L by review surface only:

| Size  | Meaning                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------- |
| **S** | One package or one module. A diff you read in one sitting without losing the thread.                    |
| **M** | A coherent feature crossing at most two layers. Reviewable in one sitting with effort.                  |
| **L** | Too large to review in one sitting. **Must be split before dispatch.** Every L below carries its split. |

---

## 2. Current state (verified 2026-09-19)

### 2.1 What is built

| Phase | Status | Evidence |
| ----- | ------ | -------- |
| **P0** — repo foundations | **Complete** | `packages/config` (tsconfig, ESLint flat config, Prettier); root `pnpm verify` running check:env + format + build:deps + lint + typecheck + test + three verify steps; `.github/workflows/pr.yml` and `deploy-dev.yml`; three build-failing lint rules with their own tests |
| **P1** — foundation | **Complete** | API skeleton with typed config, structurally separate patient/admin OIDC guards, Pino logger with credential redaction; Compose dev stack; Prisma schema + migrations; `packages/core` kernel; global `AuditInterceptor` with `route-guard-coverage.spec.ts` failing the build on an unaudited mutating route |
| **P2** — stoma output slice | **Code complete, gate unrun** | P2.S0 sync contract; P2.S1a/b observations + sync endpoints; P2.S2a/b mobile substrate, entry screen, sync worker, correction inbox; P2.S3 web SPA; P2.S4 seed generator. **The Gate B walkthrough has never been run or recorded** |
| **P3** — entry types + config | **S1 done, S1b in flight** | P3.S1 fluid intake and meals (PRs A–E); P3.S1b Daily Net Fluid Balance on web, unmerged on `feat/web-net-fluid-balance` |

Nineteen ADRs accepted (ADR-0001 to ADR-0019). `docs/sync-contract.md` is normative and governs its implementations.

### 2.2 What is not built, and is scheduled

P3.S2 voided urine · P3.S3 admin config API · P3.S4 Quick-Add · P3.S5 remaining seed scenarios · all of P4–P9 · `apps/admin` (no directory) · `packages/core/src/fhir` · the FHIR export module · the ADR-0017 deletion and purge job (**new sprint this revision — §4.5**).

### 2.3 What is not built, and was owned by nobody until this revision

This is the finding that motivated the re-baseline. Each item below was recorded honestly at the time — in an ADR, a commit body, a README or a reviewer's report — and then had no sprint to land in.

| Item | Recorded in | Now |
| ---- | ----------- | --- |
| Device-side controls unverified on hardware (HW-1..HW-10) | ADR-0014, ADR-0015, CLAUDE.md, `docs/gate-b-hardware-verification.md` | Debt lane, after R.S2 rescopes it to Android |
| An OS-invalidated refresh token has no route back to sign-in | Read from `AuthContext.tsx` during this review | Debt lane — predicted failure of HW-6 |
| iOS backup exclusion plugin | ADR-0014 "known gap" | **Closed by decision** — out of v1 scope (§3.2) |
| WCAG 1.4.4: SVG tick labels do not scale with text zoom | P2.S3 reviewer deferral | Debt lane, `accessibility` |
| Chart's hidden description duplicates the table verbatim | P2.S3 reviewer deferral | Debt lane, `accessibility` |
| jest-axe; a web error boundary; an ADR for `sessionStorage` tokens | P2.S3 reviewer deferrals | Debt lane |
| Announcement convention for Tier 1 / Tier 2 / red-flag prompts | P2.S2b deferral | Debt lane — **blocks P7.S3**, see §7 R6 |
| `withExclusiveTransactionAsync` for the production SQLite adapter | P2.S2b deferral | Debt lane |
| Monotonic clock reference for last-write-wins | P2.S2b deferral | Debt lane |
| Mixed-entry-system daily totals policy | `apps/web/README.md` known gaps | Debt lane |
| Stale-cursor recovery never exercised against a live 409 | #34 commit body | Debt lane |
| `docs/coding-standards.md` still `TBD` | Revision 1 §2 | Debt lane |
| Doc drift: `security-hipaa.md` owes a warning that shipped; `CLAUDE.md` calls `.github/workflows/` empty | This review | R.S3 |

### 2.4 Off-plan work is a first-class lane, and revision 1 denied it

Eight of the last fifteen merged PRs belong to no sprint: the Android emulator harness (#30, #31, #37), container images built and *run* in PR CI (#33), two dev-stack image repairs (#22, #24), a security-commit repair with the tests it never had (#17), advisory remediation, and the §5.4 stale-cursor recovery (#34). Two of those repairs existed because images drifted undetected for three and five PRs respectively.

This is not waste and it is not scope creep — it is the cost of running a real deployment target. Revision 2 stops pretending the plan is a complete accounting of the work and instead names the lane (§5.7) so its volume is visible when sequencing.

---

## 3. Decisions

### 3.1 Settled — read the ADR, never this summary

| Area | ADR |
| ---- | --- |
| Sync contract and conflict semantics | [ADR-0001](../decisions/0001-sync-contract-and-conflict-semantics.md) |
| Testing strategy | [ADR-0002](../decisions/0002-testing-strategy.md) |
| Monorepo task tooling | [ADR-0003](../decisions/0003-monorepo-task-tooling.md) |
| Canonical units | [ADR-0004](../decisions/0004-canonical-storage-units.md) |
| Decimal entry and conversion rounding | [ADR-0005](../decisions/0005-decimal-volumetric-entry-and-conversion-rounding.md) |
| i18n and the shared catalog | [ADR-0006](../decisions/0006-i18n-library-and-shared-catalog.md) |
| `packages/core` ownership | [ADR-0007](../decisions/0007-packages-core-ownership.md) |
| Admin config API before console | [ADR-0008](../decisions/0008-admin-config-api-before-console.md) |
| Synthetic seed data | [ADR-0009](../decisions/0009-synthetic-seed-data-generation.md) |
| API CommonJS module system | [ADR-0010](../decisions/0010-api-commonjs-module-system.md) |
| Database roles and audit immutability | [ADR-0011](../decisions/0011-database-roles-and-audit-immutability.md) |
| Entered measurement system provenance | [ADR-0012](../decisions/0012-entered-measurement-system-provenance.md) |
| Delta cursor visibility | [ADR-0013](../decisions/0013-delta-cursor-visibility-mechanism.md) |
| On-device PHI encryption and ownership | [ADR-0014](../decisions/0014-local-phi-encryption-and-device-ownership.md) |
| Biometric local access | [ADR-0015](../decisions/0015-biometric-local-access.md) |
| Patient-local day boundary | [ADR-0016](../decisions/0016-patient-local-day-boundary.md) |
| PHI retention, deletion, the audit exception | [ADR-0017](../decisions/0017-phi-retention-deletion-and-the-audit-exception.md) |
| Measured/Estimated SNOMED qualifiers | [ADR-0018](../decisions/0018-estimation-method-snomed-code.md) |
| Client clock-skew allowance | [ADR-0019](../decisions/0019-clock-skew-allowance.md) |

Revision 1's D1–D10 are all recorded above. **D3 (git workflow) is resolved** in `docs/git-workflow.md`. **D4 (the SNOMED estimation code) is resolved** by ADR-0018 — the "do not invent a code" discipline worked, and the amendment that followed it is why `method: null` now means exactly one thing.

### 3.2 Decided 2026-09-19, and what each one obliges

**1 — v1 ships Android only.** iOS leaves v1 scope. `apps/mobile` has never been built for iOS: no `eas.json`, no macOS in the development loop, and the native configuration (the SQLCipher config plugin, `NSFaceIDUsageDescription`, keychain accessibility classes) has never compiled. Rather than carry a platform claim nothing verifies, v1 states one platform and proves it.

_Obliges:_ ADR-0020; amendments to SRS §2 and §4.2; `app.json`'s `platforms`; a rescope of `docs/gate-b-hardware-verification.md` to its Android steps; CLAUDE.md. Closes the iOS backup-exclusion gap by removing its platform. **This is R.S2 and it is not optional bookkeeping** — until it lands, five HW steps are blocked on a build path nobody is building.

**2 — Gate B is run now, blocking further feature work.** P3 proceeded past an unrun gate. The gate exists to stress sync, conflict, idempotency, offline re-enforcement and audit coverage *while they are still cheap to move*, and every sprint added since makes them less so. This is R.S1.

**3 — The staging/Cognito spike becomes a named sprint at Gate C** (P4.S6), not a footnote under a gate heading. Revision 1 called pulling it forward "the strongest structural recommendation in this plan" and then gave it no owner, no exit criteria and no ID — which is why it did not happen.

**4 — The debt lane is tracked as GitHub issues**, labelled `debt`, and **one debt item is dispatched between every two feature sprints**. Not a register file: a file nobody is forced to open drifts exactly the way the deferrals in §2.3 did. The rule is the mechanism; the label is only how you find them.

### 3.3 Still open

| Open question | Blocks | Disposition |
| ------------- | ------ | ----------- |
| Mobile e2e tooling (Maestro or otherwise) | Nothing yet | ADR-0002 defers to Gate C. The emulator harness changes the calculus — decide at P4.S7 |
| Does `packages/ui` share across React Native and web, or stay tokens + web components? | P5 and P6 client work | R4. Decide at P4.S7 and write the ADR either way |
| Mixed-entry-system daily totals policy | Correctness of a displayed total | Debt lane; needs a stated policy, not more rounding |
| Announcement convention for Tier 1 / Tier 2 / red-flag prompts | **P7.S3** | Debt lane, but must be closed before P7.S3 is dispatched |
| Acceptance criteria for Epics 3–11, 15, 16 | P3.S4, P5.S2, P5.S6 | R6. Write AC into the spec before dispatching P5.S2 and P5.S6 |
| RxNorm subset and API | P5.S4 | External. Resolve by Gate C |
| Retention horizon's operational *value* for tombstone purge | P5.S7 | ADR-0017 set the policy; the purge job sets the mechanism |

**Blocked externally — do not schedule as engineering work:** penetration-test cadence (P9); RxNorm and SNOMED CT license terms (P5.S4 design, P9 sign-off); numeric performance targets (P9.S4, pending P4.S5). Note that ADR-0017 and `docs/compliance/breach-notification.md` changed the compliance framing: the FTC Health Breach Notification Rule governs, so **no BAA is legally required** and P9.S5 must be re-derived from that document rather than from revision 1's HIPAA assumption.

---

## 4. Sequenced work

### 4.1 Phase R — Reset (next, blocking)

_Produces no new capability. Closes the gate that P3 walked past, and makes the scope claims true._

**R.S1 — Gate B walkthrough (M) — `expo-mobile-developer` + main session**
Merge `feat/web-net-fluid-balance` first. Bring up the Compose stack, `scripts/dev-reset.sh`, and the emulator harness. Run the Gate B script end to end and record it in `docs/gate-b-walkthrough.md`: airplane-mode entry with an instant local save confirmation; reconnect and sync; an audit row carrying before/after; a forced conflict leaving the loser in `audit_events`; an intentionally invalid queued operation reaching the correction inbox rather than vanishing; the web view rendering the entry with its Measured/Estimated badge.
_Exit:_ every clause observed and recorded, or recorded as failed with a `bug` issue. The walkthrough doc is committed. **Recorded as "exercised on an emulator"** — it does not touch the hardware caveat.
_Reviewers:_ `code-reviewer` on any fix; `hipaa-compliance-reviewer` if the audit or sync clauses fail.

**R.S2 — Android-only v1 (S) — main session + `expo-mobile-developer`**
ADR-0020 recording the cut and its reasoning; SRS amendments at §2 and §4.2 (the two sections that actually name iOS — §4.3 does not); `app.json` `platforms` narrowed; `docs/gate-b-hardware-verification.md` rescoped to HW-1, HW-2, HW-3, HW-6a, HW-7, HW-8 plus an Android background-termination step replacing HW-10; CLAUDE.md's platform and caveat lines.
_Exit:_ no document in the repo claims iOS in v1; no HW step is blocked on a build path that does not exist; ADR-0014's iOS backup gap is closed by scope rather than left open.
_Reviewers:_ `hipaa-compliance-reviewer` (the gap being closed is a PHI-egress gap), `code-reviewer`.

**R.S3 — Plan and doc reconciliation (S) — main session**
Fix the drift this review found: `docs/security-hipaa.md` still owes the unsynced-entry warning that shipped; `CLAUDE.md` describes `.github/workflows/` as empty; the P3.S1b label (see below). Open the `debt` issues from §2.3. Adopt the sprint-ID rule in §5.8.
_Exit:_ every statement in CLAUDE.md and `docs/` that this review found stale is corrected or has an issue.

> **The P3.S1b label.** The Daily Net Fluid Balance work on `feat/web-net-fluid-balance` was labelled P3.S2 in CLAUDE.md, but `apps/api`'s code comments already use P3.S2 for voided urine (`9187-6`). It is the web consumer of P3.S1's intake data, so it is **P3.S1b**, and CLAUDE.md is corrected on that branch before merge. Voided urine keeps P3.S2 — one CLAUDE.md line changes instead of a dozen code comments.

### 4.2 Phase P3 — Remaining entry types and the configuration surface (resumes after R)

| Sprint | Size | Owner | Goal | Spec / AC |
| ------ | ---- | ----- | ---- | --------- |
| **P3.S2** | M | `expo-mobile-developer` + `nestjs-api-developer` (serial) | Voided urine: same Measured/Estimated contract, the pale-to-dark colour scale **with a text label on every step**, colour-without-volume as a valid entry, and **exclusion from Daily Net Fluid Balance** | §3.7, AC 12.1 AC1–AC4 |
| **P3.S3** | M | `nestjs-api-developer` + `fhir-data-modeler` | `/api/v1/admin/...` config API at final shape: value sets (retire, never delete), default range tables, validation thresholds. Separate guard, separate audience, every change audit-logged. **Plus the maintenance script R7 promised and revision 1 never scheduled** — today a threshold can only be changed by editing a migration | §3.11, §5.2, ADR-0008 |
| **P3.S4** | S | `expo-mobile-developer` | Quick-Add widgets generated from the patient's own recent entries. Must resolve on tap with **no loading state**. No spec AC — state exit criteria in the dispatch | §3.1, Epic 3 |
| **P3.S5** | S | `fhir-data-modeler` | Remaining seed scenarios except `leak-cluster` (P5): `high-output-dehydration`, `new-post-op`, `colostomy-baseline`, `validation-edge-cases` | `deployment-development.md` |

### 4.3 Phase P4 — Onboarding, preferences, suggested ranges, and the Gate C spikes

_This is where the app becomes usable by a real patient. Note the prerequisite nothing states today: a `patients` row currently exists only because the seeder wrote one, so **P4.S1 is what makes a genuine first run possible at all**._

| Sprint | Size | Owner | Goal | Spec / AC |
| ------ | ---- | ----- | ---- | --------- |
| **P4.S1** | M | `expo-mobile-developer`, then `react-web-developer` | Onboarding: **only three mandatory fields** (ostomy type, surgery date, measurement system), everything else skippable with deferred prompts. Surgery date becomes the Tier 1 lower timestamp bound | §3.0, Epic 7 |
| **P4.S2** | M | `nestjs-api-developer` + `react-web-developer` | Suggested ranges seeded from clinical defaults keyed to ostomy type and time since surgery; **an unconfirmed suggestion is never an active threshold**; adaptation proposed, never silent; physician-set values never auto-changed | §3.9, AC 14.1 AC1–AC4 |
| **P4.S3** | M | `expo-mobile-developer` + `react-web-developer` | Preferences covering everything §3.10 lists; preference changes queue through the sync path like any other write | §3.10, Epic 15 |
| **P4.S4** | S | `react-web-developer` | Measurement-system switch re-renders all history in the new units **without rewriting stored canonical values** | §3.10, ADR-0004 |
| **P4.S5** | S | `nestjs-api-developer` + clients | **The §5.1 performance spike.** Measure real p95 save latency, cold start, and 30–90 day history load, so §5.1's directional statements can become testable targets at P9.S4 | §5.1 |
| **P4.S6** | M | `devops-deployment-engineer` | **The staging/Cognito spike** (decision 3). A minimal Fargate task, a real Cognito user pool, TLS. Proves only two things: the OIDC adapter's claim mapping works against real Cognito with no code change, and the container runs under Fargate's health-check semantics. Not full staging | R2 |
| **P4.S7** | S | `react-web-developer` + `expo-mobile-developer` | **Two deferred decisions, closed with ADRs either way:** does `packages/ui` share across React Native and web (R4), and what mobile e2e tooling (ADR-0002). The emulator harness is now evidence for the second | R4, ADR-0002 |

> **GATE C — usable core.** A patient onboards in three fields, logs output/intake/urine/meals offline, adjusts preferences and targets, and a reader sees a correct view of two of the four hydration signals. Both spikes have run and produced numbers and an ADR respectively; P4.S7's two decisions are recorded.

### 4.4 Phase P5 — History, physician view, exports, appliance/skin, medications, reminders, deletion

| Sprint | Size | Owner | Goal |
| ------ | ---- | ----- | ---- |
| **P5.S1** | M | `expo-mobile-developer` + `react-web-developer` | History: filter/search by category; edit and delete with the §3.6 audit trail (original + corrected value) |
| **P5.S2** | M | `react-web-developer` | Physician view proper: chronological overlays with medication times, intake, output, appliance and skin events; anomaly highlighting against effective ranges with provenance shown. **Signals stay separate.** Needs AC written into the spec first (R6) |
| **P5.S3** | M | `expo-mobile-developer` + `nestjs-api-developer` + `fhir-data-modeler` | Appliance changes with auto-calculated wear time, leak events, peristomal skin severity, photos via **short-lived presigned URLs with path-style addressing** and **no patient identifier or clinical value in the object key**. Plus the `leak-cluster` seed scenario |
| **P5.S4** | M | `nestjs-api-developer` + `expo-mobile-developer` | Medications: RxNorm lookup, patient-friendly term mapping, RXCUI storage in `medication_administrations`. _Blocked on the RxNorm subset/API question_ |
| **P5.S5** | M | `expo-mobile-developer` + `nestjs-api-developer` | Reminders: medication, adaptive appliance-change, hydration nudges; quiet hours; per-category enable/disable; push behind the adapter |
| **P5.S6** | M | `fhir-data-modeler` + `nestjs-api-developer` | FHIR R4 `Bundle` export (`packages/core/src/fhir` is built here), PDF generation, and **read-only expiring scoped share links** — the route by which a physician is intended to reach the data. Until this lands, `apps/web` must keep claiming no physician audience. Needs AC written into the spec first (R6) |
| **P5.S7** | M | `nestjs-api-developer` + `fhir-data-modeler` | **NEW — account deletion and the ADR-0017 purge job.** Revocation and sync refusal at once; a privileged job running as the owner role, **unreachable from request handling**, hard-purging observations, tombstones, queue state, profile **and that patient's audit rows** within 30 days; idempotent, re-runnable, and recording completion rather than merely starting. Tombstone purge horizon follows from it (`sync-contract.md` §10) |

> **P5.S7 is a compliance obligation with a policy and no mechanism.** ADR-0017 is accepted, `docs/compliance/breach-notification.md` relies on it, and nothing in `apps/api` implements it. It narrows ADR-0011 rather than contradicting it: the guarantee is "no request handler can delete an audit row", never "nothing can".

### 4.5 Phases P6–P9 — unchanged in content

P6 (weight and composite hydration status), P7 (resting heart rate, concordance, red flag), P8 (admin console) and P9 (staging parity, hardening, pre-launch) stand as written in revision 1, with three amendments:

1. **P7.S3 cannot be dispatched until the announcement-convention debt item is closed** (§3.3). The distinctness of the red-flag voice from a validation warning is a patient-safety property carried entirely by copy and by how it is announced to a screen reader; deciding that convention inside the red-flag sprint is deciding it under the worst possible pressure.
2. **P9.S4** converts P4.S5's spike results into §5.1 numeric targets — the dependency now has an ID.
3. **P9.S5** is re-derived from `docs/compliance/breach-notification.md`. Under the FTC rule this product is neither a covered entity nor a business associate, so "BAA execution" is not a gating artifact in the form revision 1 assumed. The technical safeguards still stand as a voluntary standard, and the framing changes the moment a provider offers the app to their patients — the likely route being P5.S6's share link.

Gates D (four signals live), E (a threshold change governs the next entry with no release) and F (production eligible) are unchanged.

---

## 5. Delegation and collaboration model

### 5.1 The structural constraint

Subagents start with a fresh context window every invocation and cannot dispatch each other. The main session is the only coordinator.

> **Anything that must survive between two agent invocations has to be in a file. The main session's conversation is not a durable channel.**

| State | Lives in |
| ----- | -------- |
| Settled decisions | `design-specs/decisions/NNNN-*.md` |
| Sync wire contract | `docs/sync-contract.md` + `packages/core/src/sync/` |
| Data contract | `apps/api/prisma/schema.prisma` |
| API contract | generated OpenAPI → `packages/core/src/api-client` |
| Validation, units, hydration, i18n | `packages/core` |
| Terminology status | `design-specs/data-model/fhir-rxnorm-integration.md` |
| Test conventions | `docs/testing.md` |
| Real commands | `docs/getting-started.md` |
| Device verification status | `docs/gate-b-hardware-verification.md` |
| **Open debt** | **GitHub issues labelled `debt`** |

### 5.2 Ownership of `packages/core`

| Path | Authored by | Everyone else |
| ---- | ----------- | ------------- |
| `src/{validation,units,hydration,i18n}` | `react-web-developer` | read-only |
| `src/fhir` | `fhir-data-modeler` | read-only |
| `src/sync` | `nestjs-api-developer` | read-only |
| `src/api-client` | **generated; never hand-edited** | generated |

An agent needing a change in a path it does not own **stops and reports** rather than editing. The main session dispatches a separate S-sized sprint to the owner, then re-dispatches.

### 5.3 Serial vs. parallel dispatch

**Strictly serial:** any API endpoint → the client consuming it (the generated client is the gate); schema → audit/threshold service → endpoints; contract → sync endpoints → mobile sync.

**Safe in parallel:** within P3, S2 ∥ S4 after their shared migration; within P4, S5 ∥ S6 ∥ S7 (spikes and decisions touch no product code); within P5, S1 / S3 / S4 / S5 touch largely disjoint modules.

**Never parallel, for boundary reasons:** an `apps/web` sprint and an `apps/admin` sprint, in the same invocation or to the same agent instance.

### 5.4 Reviewer cadence

All three reviewers are read-only. **They report; the main session applies fixes.**

| Reviewer | Runs on |
| -------- | ------- |
| `code-reviewer` | Every sprint, without exception |
| `hipaa-compliance-reviewer` | Any sprint touching PHI paths, audit logging, auth, logging, seed/test data, infrastructure, or the admin boundary. **Blocking on R.S2, P3.S3, P5.S3, P5.S7, P8.S1 and all of P9** |
| `accessibility-copy-reviewer` | Any sprint producing user-facing UI or strings. **Blocking on P3.S2 (the colour scale), P6.S2 (absolute-terms copy) and P7.S3 (red-flag distinctness)** |

A reviewer deferral is not a closure. **Every "deferred, with reasoning recorded" outcome becomes a `debt` issue in the same session that records it** — that rule is the direct lesson of §2.3, where nine such deferrals sat in commit bodies nobody re-read.

### 5.5 What every delegation prompt must carry

1. The sprint ID and its one-sentence goal.
2. The exact file paths in scope, and the paths explicitly out of scope.
3. The contract files to read first.
4. The SRS §7 acceptance criteria by ID that constitute exit — or, where none exist, the exit criteria stated explicitly.
5. Which cross-cutting requirements apply.
6. Which reviewers will run.

### 5.6 Roster

Nine agents: five builders, one planner, three read-only reviewers. Unchanged, and still correct. The `apps/admin` ownership gap remains the most concerning: the same agent owns the patient web app and the zero-PHI console. Mitigations stand — never dispatched together, `hipaa-compliance-reviewer` on every admin sprint, and the import-boundary lint rule as a fast secondary check behind the load-bearing controls (a disjoint identity pool and `apps/admin`'s dependency closure).

### 5.7 The maintenance lane

Infrastructure repair, CI gaps, dependency advisories and tooling are **expected recurring work**, not interruptions. Revision 1 had no lane for them and they consumed roughly a third of merged PRs anyway. Sequence with that in mind rather than treating each as a surprise.

Two rules earned by §2.4's two image-drift incidents:

- **A CI check that only builds an artifact proves less than it appears to.** `pr.yml` now also *runs* the images and asserts their content, because the web placeholder built perfectly for three sprints and a missing workspace package fails at `require` time, not at `docker build` time.
- **A green `pnpm verify` is not a uniform signal.** The integration suite skips itself when Docker is unreachable, so ownership authorization, audit coverage, the append-only grant check and the no-PHI-in-logs assertions can all silently not run. Start Docker before trusting it, and say which way it ran when reporting.

### 5.8 Sprint-ID discipline

A sprint ID is claimed in this document **before** it appears in a commit message, a code comment or CLAUDE.md. P3.S2 was simultaneously voided urine (in `apps/api`'s comments) and the web fluid-balance work (in CLAUDE.md) because an off-plan sprint borrowed a number nobody had reserved. Off-plan work takes a letter suffix on the sprint whose surface it extends (P3.S1b), or no ID at all.

---

## 6. Cross-cutting requirements — status

| Concern | Established at | Standing rule |
| ------- | -------------- | ------------- |
| **Audit logging** | P1.S5 | Global interceptor; `route-guard-coverage.spec.ts` fails the build on an unaudited mutating route. The observation write and its audit row commit **in one transaction** — copy that shape, never re-derive it |
| **i18n externalization** | P0.S1 lint rule + P1.S4 catalog | Every namespace in `packages/core`. `mobile` and `web` are scoped by app, not audience, and may hold only shell copy with no clinical meaning |
| **Unit preference** | P1.S4 | Canonical mL/kg; conversion is render-time; mixed-system values unrepresentable in the type |
| **Accessibility** | P2.S3 `packages/ui` | Primitives carry accessible names, label association, focus indication and touch-target sizing. Contrast ratios are **computed, not claimed** — every hand-written ratio in the first version was wrong. Two AA defects are open in the debt lane |
| **Admin/patient boundary** | P0.S1 lint rule + P1.S1 guards | Structurally separate guards, never a shared guard with a role check |
| **AGPL header** | P0.S1 | Enforced by lint, failing CI |
| **No real PHI outside production** | P1.S2 + P2.S4 | Seeded rows carry **no audit events** — a test asserting audit coverage must create its data through the API |
| **Never log PHI** | P1.S1 | Serializers never assemble a body into a log line. There is nothing for a "scrubber" to scrub because no PHI payload is logged in the first place |
| **Thresholds as configuration** | P1.S4 + P1.S5 | Seeded by **migration**, not by `packages/seed` — `ThresholdsService` throws without them and that sits on every clinical write path. Mobile's cache is deliberately unseeded: a default there is a hardcoded threshold wearing a database costume |
| **Patient-local day** | P2.S2b (ADR-0016) | Captured per observation as IANA zone + `local_date`; never re-derived from a profile or a reader's timezone |
| **Device-side controls** | P2.S2a (ADR-0014/0015) | **Implemented, unverified.** `docs/gate-b-hardware-verification.md` holds HW-1..HW-10; none are closed. An emulator pass never closes one |

---

## 7. Risks

**R1 — The sync engine is the hardest thing in this system.** _Partly retired._ The contract is written and normative, conflict and idempotency are implemented and tested, and §5.4's stale-cursor recovery now performs rather than reports. _Still live:_ nothing has been exercised against a live 409, and the whole path has never been observed end to end on a device — which is precisely what R.S1 closes.

**R2 — Staging concentrates every parity risk at the end.** _Mitigation now has an ID:_ P4.S6. Fargate orchestration, TLS, real Cognito token lifetimes and refresh rotation, MFA, hosted-UI and email flows, KMS, Multi-AZ and DR remain untested until it runs.

**R3 — Single-human review bandwidth.** Unchanged, and the §2.3 list is what it looks like when it binds: work gets recorded instead of done. The debt lane's one-item-between-sprints rule is the throttle.

**R4 — `packages/ui` cross-platform sharing may not pay off.** Now decided at P4.S7, ADR either way. Currently tokens + web components, which is the conservative position revision 1 recommended.

**R5 — The SNOMED estimation code.** _Retired._ ADR-0018, amended: both answers carry an explicit qualifier and `method: null` at rest means one thing.

**R6 — Missing acceptance criteria for Epics 3–11, 15, 16.** Live and now acute: P5.S2 and P5.S6 are the two where "done" is genuinely ambiguous, and P5.S6 is also the physician-access route. Write AC into the spec before dispatching either.

**R7 — Thresholds are load-bearing long before the console that manages them.** _Partly retired_ — defaults ship by migration with `ON CONFLICT DO NOTHING`. _Still live:_ there is no way to change one without editing a migration. P3.S3 carries the maintenance script.

**R8 — NEW: verification is weaker than it looks.** Three suites can be green while proving much less than a reader assumes: the integration suite skips itself without Docker; no device or simulator runs anywhere in CI; and there is no mobile e2e at all. The mitigation is not more unit tests — it is R.S1, the HW list, and P4.S7's e2e decision.

**R9 — NEW: documentation drift is a recurring defect class, not an oversight.** CLAUDE.md described an empty `.github/workflows/`; `security-hipaa.md` owed a warning that had shipped; this plan described a repo that no longer existed; a sprint ID meant two things. Each was written accurately and then outlived its truth. The rule that answers it is already in CLAUDE.md — *when a decision changes something this file states, change it in the same commit* — and it needs extending to `docs/` and to this plan, which is why R.S3 exists and why §5.8 is a rule rather than an observation.

**R10 — NEW: the Android-only cut narrows the tested surface, not the claimed one, unless R.S2 actually lands.** `app.json` still names iOS, SRS still names iOS in three places, and Expo will still happily build an iOS bundle nobody has run. A scope cut that lives only in a planning document is worse than no cut, because it removes the pressure to verify without removing the claim.

---

## 8. Findings from this review

**F5 — The Gate B walkthrough was never run, and P3 proceeded past it.** Addressed by decision 2 and R.S1. Worth naming as a process failure rather than an oversight: nothing in the plan made a gate *blocking* in any mechanical sense, so it was simply not a step anyone had to take.

**F6 — Nine reviewer deferrals were recorded in commit bodies and never re-read.** Addressed by decision 4 and the §5.4 rule. The deferrals were the right call each time; the failure was that a commit body is a write-only medium.

**F7 — A predicted defect in the biometric invalidation path.** `AuthContext.unlock()` reads the refresh token inside a `try` with a deliberately silent `catch`, and `hasStoredRefreshToken()` answers from a marker key that an OS invalidation does not clear. So when the OS invalidates the key after a biometric enrolment change, the app unlocks, reports an authenticated session, holds no access token, syncs nothing, and offers no route to sign-in. ADR-0015's "forces a full OIDC re-login" describes an intention the build does not implement. Read from the code, not observed — HW-6a is the step that settles it.

**F8 — `apps/web` has no patient-facing entry surface and no physician access route.** It renders the signed-in account's own records; `GET /api/v1/observations` takes no patient identifier anywhere, so there is no physician identity and no patient-selection path, and the copy deliberately claims neither. That is correct today and it means the web client's role in v1 is decided by P5.S6's share link. Do not let a P5.S2 "physician view" sprint reintroduce an audience the API cannot authorize.

**F9 — Nothing owns the ADR-0017 purge job.** Policy accepted, compliance documentation relying on it, no mechanism. Now P5.S7.

**F10 — Revision 1's §2 was allowed to describe a repository that had not existed for months.** A planning document with a stale "current state" is not merely unhelpful: agents read it and trust it. This revision dates its state section and §5.8 makes the ID discipline explicit, but the durable fix is to re-baseline at every gate rather than at every crisis.
