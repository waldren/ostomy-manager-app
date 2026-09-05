# v1 Implementation Plan — Ostomy Patient Management Application

Status: active · Derived from `design-specs/requirements/SRS_v2.md` (now v2.4)

**Decision status (updated 2026-09-05).** D1–D2 and D5–D10 are now accepted ADRs; F1 and F2 are resolved and the spec is corrected. Read the ADR, not this plan's summary, before implementing — the ADRs are normative and this section is a pointer.

| Plan item                              | Now recorded as                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1 sync contract                       | [ADR-0001](../decisions/0001-sync-contract-and-conflict-semantics.md)                                    |
| D2 testing strategy                    | [ADR-0002](../decisions/0002-testing-strategy.md)                                                        |
| D7 monorepo tooling                    | [ADR-0003](../decisions/0003-monorepo-task-tooling.md)                                                   |
| D9 canonical units                     | [ADR-0004](../decisions/0004-canonical-storage-units.md)                                                 |
| F2 decimal entry + conversion rounding | [ADR-0005](../decisions/0005-decimal-volumetric-entry-and-conversion-rounding.md) — **changed the spec** |
| D8 i18n                                | [ADR-0006](../decisions/0006-i18n-library-and-shared-catalog.md)                                         |
| D10 `packages/core` ownership          | [ADR-0007](../decisions/0007-packages-core-ownership.md)                                                 |
| D5 admin console timing                | [ADR-0008](../decisions/0008-admin-config-api-before-console.md)                                         |
| D6 seed data                           | [ADR-0009](../decisions/0009-synthetic-seed-data-generation.md)                                          |
| F1 three-vs-four signals               | Fixed in SRS v2.4, AC 17.3 AC 2                                                                          |
| D3 git workflow                        | Still open — belongs in `docs/git-workflow.md` at P0.S2, not an ADR                                      |
| D4 SNOMED estimation code              | Still open — external terminology lookup. Do not invent a code.                                          |

**Still blocking P0.S1: D3 only.** D2 and D7 are settled.

## 1. Objective

Sequence the work from today's scaffolding-only repo through complete v1 (all six approved SRS phases), as a series of bounded delegation units sized by reviewable diff.

**In scope:** repo tooling and process docs; the on-prem Docker Compose dev stack; the FHIR-shaped schema; `packages/core`; the API; both patient clients; the admin console; staging/production IaC; the compliance artifacts that gate production.

**Deliberately excluded:** everything in SRS Appendix A (urostomy, wearables, education library, gamification, live care-team portal accounts). Spanish or any second locale — v1 is English-only, though the i18n plumbing is in scope from sprint one. Numeric performance targets, which SRS §5.1 defers until a spike exists (the spike is scheduled; the targets are not invented here).

**No durations anywhere.** Sizing is S/M/L by review surface only:

| Size  | Meaning                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------- |
| **S** | One package or one module. A diff you read in one sitting without losing the thread.                    |
| **M** | A coherent feature crossing at most two layers. Reviewable in one sitting with effort.                  |
| **L** | Too large to review in one sitting. **Must be split before dispatch.** Every L below carries its split. |

---

## 2. Current state (verified)

- `package.json` — name, version, description, license; **empty `scripts`, empty `devDependencies`**. No lockfile.
- `pnpm-workspace.yaml` — `apps/*` and `packages/*`. Nothing to resolve.
- `apps/api`, `apps/web`, `apps/mobile` — README stubs, each marked "Not yet scaffolded." **No `apps/admin`.**
- `packages/core`, `packages/ui`, `packages/config` — one-line README stubs. No source, no `package.json`.
- `.github/workflows/` — README only, no workflows.
- `infra/`, `scripts/` — README only.
- `design-specs/decisions/` — **`README.md` + `0000-template.md` only. Index reads "No decisions recorded yet." Confirmed: zero accepted ADRs.** Every architecture constraint currently in force comes from SRS §4 and `CLAUDE.md`.
- Docs written and substantive: `deployment-development.md` (the dev environment methodology, including the deferred-risk list), `architecture.md` (thin), `license-header.md`, `getting-started.md` (commands are `TBD`).
- Docs that are stubs and gate work below: `coding-standards.md`, `git-workflow.md`, `testing.md`, and the "Developer practices" half of `security-hipaa.md`.
- `design-specs/data-model/fhir-rxnorm-integration.md` — three short sections; open questions include the SNOMED CT estimation-technique code, the RxNorm subset/API, and FHIR versioning. It cites the v1.0 PDF as "the SRS," which is now stale.
- `.claude/agents/` — nine agents: five builders, one planner, three reviewers. Reviewers and planner have no write tools by design.

**Consequence:** there is no `pnpm install` that works, no lint, no typecheck, no test runner. Every sprint's exit criteria below depend on P0 existing first.

---

## 3. Decisions needed before work starts

Each is labeled by provenance. **[SPEC]** = SRS states it, not open. **[GAP]** = the spec does not cover it and you must decide. **[EXTERNAL]** = blocked on someone outside engineering.

### D1. Sync contract shape and conflict/idempotency semantics — ADR (highest priority)

**[SPEC]** settles: local write → `sync_queue` (op type, entity, payload, client UUID, client timestamp); push in timestamp order; last-write-wins by timestamp applied server-side; loser to the audit log; `updated_since` delta pull; rejected ops retained locally and surfaced (§4.5, §3.8, AC 13.1 AC4).

**[GAP]** — everything about the wire format:

| Open question        | Options                                            | Recommendation                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency key      | Client entity UUID / separate per-operation UUID   | **Per-operation UUID.** Entity UUID alone cannot distinguish a replayed create from a legitimate later update of the same row.                                                                                       |
| Batch failure mode   | All-or-nothing / per-operation results             | **Per-operation results** (`accepted` \| `rejected` + machine-readable reason + field). All-or-nothing makes one bad row block a patient's entire backlog, which is exactly the data-loss shape §5.3 forbids.        |
| Delete semantics     | Hard delete / tombstone rows                       | **Tombstones.** A hard delete cannot propagate through a delta cursor to a second device, and §3.6 requires the deletion be auditable anyway.                                                                        |
| Cursor type          | `updated_at` timestamp / monotonic server sequence | **Server-assigned monotonic sequence.** Timestamp cursors lose rows written inside the same millisecond and break on any clock adjustment.                                                                           |
| Clock-skew allowance | Constant in code / admin-managed threshold         | **Admin-managed threshold** like every other bound, with a stated default. This is a _proposal_ — the spec does not name a value, and inventing one as a code constant would violate "thresholds are configuration." |
| Ordering             | Strict client-timestamp order / server-reordered   | **Strict client-timestamp order within a batch**, since LWW resolution depends on it.                                                                                                                                |

Write `docs/sync-contract.md` **and** the ADR before any sync code exists. This is the single most expensive thing to change later.

### D2. Testing strategy — fills `docs/testing.md`; ADR-worthy for the framework split only

**[GAP].** `docs/testing.md` is a stub and every sprint below cites test-based exit criteria, so this blocks sprint one.

**Recommendation (proposal):**

- **Vitest** for `packages/core`, `packages/ui` (web), `apps/api` unit, `apps/web`, `apps/admin`.
- **jest-expo** for `apps/mobile` — forced, not chosen; Vitest does not carry the React Native preset cleanly.
- **Supertest + a real Postgres** (Testcontainers locally and in CI) for API integration. Mocking Prisma would not exercise the constraint that matters most: the audit table having no update/delete path.
- **Playwright** for web e2e; **defer mobile e2e** (Maestro) until Gate C — the sync path is the thing worth e2e testing and it does not stabilize until then.
- **AC traceability convention:** any test covering a spec acceptance criterion names it (`describe('AC 13.1 AC3 — server-side re-enforcement')`). This is the only mechanism that keeps SRS §7 connected to code once the repo grows.

The cost: two test runners in one monorepo, and `pnpm test` at root must fan out to both. Accept it — the alternative is Jest everywhere, which is slower and worse for the packages that are the majority of the code.

### D3. Git workflow and branch/PR strategy — fills `docs/git-workflow.md`; not ADR-worthy, but blocking

**[GAP].** Blocking because `docs/deployment-development.md` specifies the dev deploy triggers on **push to `main`** — so the branch model determines when the dev host redeploys.

**Recommendation (proposal):** one short-lived branch per sprint (`sprint/p2-s1-observations-api`), PR required, squash merge to `main`, Conventional Commits, PR template carrying a reviewer-agent checklist (which of the three reviewers ran, and their verdict). No long-lived develop branch — with one human reviewer, a second integration branch is pure overhead.

### D4. SNOMED CT estimation-technique code — [EXTERNAL] terminology lookup, not engineering

`CLAUDE.md`, SRS §4.4, and `fhir-rxnorm-integration.md` all flag this as open. **Do not invent a code.** A wrong SNOMED code is a silent, durable data-quality defect that only surfaces at FHIR export or EHR integration — i.e. after thousands of rows carry it.

**Recommendation:** define it in exactly one place in `packages/core` as `ESTIMATION_METHOD_CODE` with a `TODO(code-unverified)` marker, so resolution is a one-line change plus a data migration over `observations.method`. Do not let it block the P2 slice. Record the resolution in `fhir-rxnorm-integration.md` and write an ADR when it lands. The same discipline applies to the RxNorm subset/API question, which blocks P5.S4 and should be resolved by Gate C.

### D5. Does the admin console land in this plan, and when? — ADR

**[SPEC]** requires the console (§3.11) and requires thresholds and value sets to be database configuration from the first validation rule (§3.8). Those two facts have different timing.

**Recommendation:** split them. The **config tables and the `/api/v1/admin/...` API surface land at P1/P3** because validation cannot be spec-compliant without them. The **console SPA lands at P8**, after the four hydration signals. Until P8, config is seeded by migration and changed by a maintenance script.

**What this costs:** between P3 and P8, a clinical threshold change requires running a script against the dev database rather than clicking a UI — acceptable while the only user is the developer. **What it forecloses:** nothing, provided the admin API is built to its final shape (separate guard, separate audience, audit-logged, retire-never-delete) at P3 and the console is only a client of it. Building a shortcut admin API and rewriting it at P8 would be the failure mode.

### D6. Synthetic seed data generation — ADR-lite

**[SPEC]** names the six scenarios, determinism, relative-to-now timestamps, valid-by-construction, and synthetic-always (`docs/deployment-development.md`).

**[GAP]** — where it lives and how it writes.

**Recommendation:** a `packages/seed` workspace that writes through **Prisma directly** but **validates every generated row against `packages/core` before insert**. Writing through the HTTP API would exercise validation for free but makes seeding slow, dependent on a running API, and awkward to invoke from the `migrate` one-shot container. Validating pre-insert gets the guarantee without the coupling. The `validation-edge-cases` scenario deliberately bypasses Tier 2 (that is its purpose) but never Tier 1.

### D7. Monorepo tooling — proposal, ADR only if adopted

**[GAP].** SRS §4 specifies pnpm workspaces and says nothing about a task runner.

**Recommendation: plain pnpm scripts now; revisit at Gate C.** Turborepo's caching layer has to be reconciled with the multi-stage Docker build strategy already written into `docs/deployment-development.md`, and adding that complexity before there are five workspaces and a real test suite buys nothing. The trigger to revisit is PR CI time, not workspace count.

### D8. i18n library and catalog ownership — ADR (cheap now, expensive later)

**[SPEC]** requires no hardcoded strings and locale-aware formatting from day one (§5.4), which means this must be decided **before the first screen**, not before the first translation.

**Recommendation:** `i18next` + `react-i18next` (the only mature option that works unchanged across React Native and web), with `Intl`-based date/time/number/unit formatters in `packages/core`. **One shared English catalog in `packages/core/i18n/`**, not per-app catalogs — because `accessibility-copy-reviewer` must be able to audit reading level, tone, and the red-flag/warning voice distinction in one place. Per-app catalogs would let the same warning be phrased two ways on two clients, which is precisely the failure mode that agent exists to catch.

### D9. Canonical storage units — ADR

**[GAP].** SRS §3.10 says stored canonical values are never rewritten when preference changes, but never states what canonical _is_.

**Recommendation:** canonical is **mL and kg**; imperial is a render-time conversion. Store the unit string on the row anyway (FHIR `valueQuantity.unit` requires it, and it makes a future re-interpretation recoverable). This is trivially cheap to decide now and data-corrupting to decide after rows exist.

### D10. `packages/core` ownership — ADR (see §5.2)

**[GAP], and a genuine conflict in the current agent roster.** `react-web-developer`'s charter claims `packages/core`; `nestjs-api-developer` and `expo-mobile-developer` both consume it and will both want to change it mid-sprint. Resolution in §5.2.

### D11–D14. Blocked externally, do not schedule as engineering work

| Item                                                                       | Blocked on                                                           | Gates                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| PHI retention period, deletion SLA                                         | Legal/compliance counsel (§5.2 says explicitly: not set in the spec) | Production only, not any code sprint |
| Penetration test cadence                                                   | Security counsel                                                     | P9                                   |
| BAA execution covering RDS, S3, Fargate/ECS, Cognito, KMS, Secrets Manager | Legal                                                                | Production PHI, per §4.6             |
| RxNorm and SNOMED CT license terms                                         | Legal (§5.2)                                                         | P5.S4 design, P9 sign-off            |
| Numeric performance targets (§5.1)                                         | The spike, scheduled at Gate C                                       | P9.S4                                |

**Do not invent values for any of these.** Note which sprint each gates, so their absence is visible rather than forgotten.

---

## 4. Sequenced work

Dependency-ordered, not epic-ordered. Six internal gates.

### P0 — Repo foundations

_Produces nothing demonstrable. Blocks every subsequent dispatch, because there is currently no way to lint, typecheck, or test anything an agent writes._

| Sprint    | Size | Owner                        | Goal                                                                                                                                                                                                                                                                                                                                                       | Touches                                              |
| --------- | ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **P0.S1** | S    | `devops-deployment-engineer` | Workspace tooling: root scripts, Node LTS pin, `packages/config` with base tsconfig, ESLint flat config, Prettier. Three lint rules matter and must exist now: **AGPL header enforcement** on new files under `apps/`/`packages/`, an **import-boundary rule** reserving the admin/patient separation, and **no-literal-string** scoped to UI directories. | `package.json`, `packages/config/*`, `.editorconfig` |
| **P0.S2** | S    | `devops-deployment-engineer` | Process docs + PR CI: fill `docs/git-workflow.md`, `docs/testing.md`, `docs/coding-standards.md`, and the "Developer practices" section of `docs/security-hipaa.md`. `.github/workflows/pr.yml` — lint, typecheck, test, dependency/vulnerability scan (§5.2) on GitHub-hosted runners. PR template with the reviewer-agent checklist.                     | `docs/*`, `.github/`                                 |

**Dependencies:** D2, D3, D7 decided first.
**Exit:** `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` all run green across an empty workspace set; a trivial PR passes CI; a file without the AGPL header fails lint.
**Reviewers:** `code-reviewer`.
**Note:** P0.S1 and P0.S2 can be one dispatch (combined = M) if D2/D3/D7 are settled beforehand.

### P1 — Foundation

_Still nothing a patient could use. Every item here is either load-bearing for correctness (audit interceptor, validation kernel) or for the environment existing at all (Compose stack). Building any feature before them means retrofitting audit logging and threshold configuration across code that already exists — the single most expensive mistake available in this plan._

**P1.S1 — API skeleton (S) — `nestjs-api-developer`**
NestJS app; `ConfigModule` with a typed, schema-validated env contract; an **OIDC-agnostic** `JwtAuthGuard` taking issuer, JWKS URI, audience, and claim mapping from config (`jose`/`jwks-rsa`, never a Cognito SDK); a **structurally separate** `AdminJwtAuthGuard` bound to a different issuer/audience, sharing no code with the patient guard; `GET /api/v1/health`; OpenAPI document generation; Pino logger configured with body logging **off** and a PHI-scrubbing serializer.
_Touches:_ `apps/api/src/{main.ts,app.module.ts,config/,auth/,health/}`.
_Exit:_ health returns 200 unauthenticated; a protected stub rejects wrong-audience and unsigned tokens; `grep -ri cognito apps/api/src` returns nothing.
_Reviewers:_ `hipaa-compliance-reviewer`, `code-reviewer`.

**P1.S2 — Dev stack (M) — `devops-deployment-engineer`**
Multi-stage Dockerfiles per the strategy in `docs/deployment-development.md`; `docker-compose.yml` with `web`, `admin` (placeholder), `api`, one-shot `migrate`, `postgres`, `minio`, `mock-oidc` (`navikt/mock-oauth2-server` — the open item in that doc, decide here); `.env.example` with placeholders only; `scripts/dev-reset.sh`; `.github/workflows/deploy-dev.yml` targeting the self-hosted runner labels.
_Touches:_ `infra/`, `scripts/`, `.github/workflows/`, `docs/getting-started.md` (replace the `TBD` commands).
_Depends on:_ P1.S1. _Parallel with:_ P1.S3, P1.S4.
_Exit:_ `docker compose up` brings the API healthy against MinIO and mock OIDC; the deploy workflow reaches the `/api/v1/health` check on the dev host; migrations run in the `migrate` service before `api` starts.
_Reviewers:_ `hipaa-compliance-reviewer` (secrets handling, log drivers, no-PHI rule), `code-reviewer`.

**P1.S3 — Schema core (M) — `fhir-data-modeler`**
Prisma schema and initial migration for only what the slice and configuration need: `patients`/`profiles`; `observations` with FHIR-mirroring columns (`resource_type`, `code`, `value_quantity_value`, `value_quantity_unit`, `effective_datetime`, `method`, `status`); `audit_events` (append-only, **no update/delete grant**); `sync_operations`; and the config family — `value_sets`/`value_set_members` with active/retired status, `clinical_default_ranges`, `validation_thresholds`, `effective_ranges` with a provenance enum in the §3.9 precedence order. Client-generated UUID primary keys on every synced entity.
_Touches:_ `apps/api/prisma/`, `design-specs/data-model/fhir-rxnorm-integration.md`.
_Exit:_ migration applies cleanly to both an empty and a populated database; a written handoff note listing which FHIR fields are covered, which codes are verified vs. `TODO(code-unverified)`, and what a `Bundle` from these tables would look like.
_Reviewers:_ `hipaa-compliance-reviewer`, `code-reviewer`.
_Note:_ deliberately partial. Appliance, leak, skin, medication, reminder, and Quick-Add tables arrive with their features as additive migrations — which is also how the migration path gets exercised against existing rows.

**P1.S4 — `packages/core` kernel (M) — `react-web-developer`**
Canonical unit types and conversion (mL↔oz, kg↔lb) per D9; the **two-tier validation engine with thresholds injected, never constant**; FHIR `Observation` mapping types; the i18n catalog scaffold and `Intl` format helpers per D8; the `ESTIMATION_METHOD_CODE` TODO constant per D4; AC-traceable unit tests.
_Touches:_ `packages/core/src/{units,validation,fhir,i18n}/`.
_Exit:_ Tier 1 and Tier 2 rules for volumetric entries at full branch coverage; a threshold-injection interface the API and both clients can each satisfy; zero numeric thresholds hardcoded; a soft warning is structurally incapable of blocking (the return type distinguishes them).
_Reviewers:_ `accessibility-copy-reviewer` (catalog structure, warning copy tone — "never scold"), `code-reviewer`.

**P1.S5 — Audit interceptor and threshold service (S) — `nestjs-api-developer`**
A NestJS `AuditInterceptor` writing user identity, timestamp, and before/after values to `audit_events`; an `AuditContext` that sync-applied writes and conflict losers pass through, so coverage is structural rather than remembered per-handler; a `ThresholdsService` reading validation thresholds and value sets from the database with cache invalidation.
_Depends on:_ P1.S3, P1.S4.
_Exit:_ an integration test proves a PHI write with no corresponding audit row fails; there is no code path and no database grant permitting `UPDATE`/`DELETE` on the audit table.
_Reviewers:_ `hipaa-compliance-reviewer` **(mandatory, blocking)**, `code-reviewer`.

> **GATE A.** Dev host serves a healthy API against Postgres, MinIO, and mock OIDC. Migrations run automatically on deploy. PR CI green. **The audit interceptor and threshold service exist before a single PHI write endpoint does.** Nothing here is demonstrable to a patient; all of it is unaffordable to retrofit.

### P2 — Vertical slice: stoma output, end to end

**Why stoma output is the right first slice.** Of the five candidate entry types it is the only one that exercises every seam at once:

- It is the app's core entity, and **the only epic SRS §7 specifies to full acceptance-criteria depth from v1.0** (AC 2.1, 2.2, 2.5) — so the exit criteria are given, not invented.
- It carries the mandatory **Measured/Estimated toggle**, which exercises `Observation.method`, the Tier 1 "missing mandatory selection" block, and forces the SNOMED gap into the open at minimum cost.
- It has **both validation tiers with concrete numbers** — negative/non-numeric (Tier 1), >2,000 mL (Tier 2, AC 2.1 AC2) — so the block-vs-warn distinction is tested from day one.
- It is **volumetric**, so the unit preference path is real, not deferred.
- It **feeds Daily Net Fluid Balance**, giving the physician view something correct to render.

Weight is simpler — no toggle, no method, no unit ambiguity beyond kg/lb — and that simplicity is exactly why it is the wrong first slice. The point of a slice is to stress the seams while they are still cheap to move.

**P2.S0 — Sync contract (S) — main session authors ADR, `nestjs-api-developer` authors types**
`docs/sync-contract.md` plus wire types in `packages/core/src/sync/`. Merged **before** any sync code.

**P2.S1 — Slice API (L → split) — `nestjs-api-developer`**

- **P2.S1a (M):** `POST /api/v1/observations` and `GET /api/v1/observations` for stoma output only. Server-side re-enforcement of every `packages/core` rule. Ownership authorization (a valid patient token must not reach another patient's row by ID). Audit coverage via the P1.S5 interceptor. OpenAPI emitted; typed client generated into `packages/core`.
- **P2.S1b (M):** `POST /api/v1/sync/push` and `GET /api/v1/sync/delta`. Per-operation accepted/rejected results; idempotency on the per-operation UUID; LWW conflict resolution with **the losing version written to the audit log**; the delta cursor.

_Exit:_ AC 2.5 AC1 (FHIR field names on the wire), AC 2.5 AC2 (`method` populated, with the SNOMED code as the tracked TODO), AC 13.1 AC3 (server-side re-enforcement on both direct and sync paths), AC 13.1 AC4 (rejection returns a correctable result, never a silent drop). A replayed batch creates no duplicate rows. A forced conflict leaves the loser in `audit_events`.
_Reviewers:_ `hipaa-compliance-reviewer`, `code-reviewer`.

**P2.S2 — Slice mobile (L → split) — `expo-mobile-developer`**

- **P2.S2a (M):** Expo app skeleton, Expo Router, `expo-sqlite` schema mirroring the slice entities plus `sync_queue`, OIDC login against mock provider, refresh token in `expo-secure-store` unlocked by `expo-local-authentication`.
- **P2.S2b (M):** Add Output screen — mandatory Measured/Estimated toggle, timestamp auto-populated and editable, **local-first save confirmed from the local write, never from a network response**; the background sync worker; the rejected-operation correction inbox.

_Depends on:_ P2.S0, P2.S1, P1.S4.
_Exit:_ AC 2.1 (1, 2, 3), AC 2.2 AC1, AC 13.1 AC1/AC2/AC4, AC 13.2 AC1. Local data survives app restart and OS background termination; sync resumes with no user action.
_Reviewers:_ `accessibility-copy-reviewer`, `hipaa-compliance-reviewer` (SecureStore, no PHI in logs or crash breadcrumbs), `code-reviewer`.

**P2.S3 — Slice web (M) — `react-web-developer`**
Vite SPA skeleton with OIDC PKCE auth; `packages/ui` primitives (accessible input, label, button, toggle, design tokens); a minimal physician view showing the day's stoma output with Measured/Estimated badges and a chronological plot. Net Fluid Balance renders as explicitly incomplete until intake exists at P3 — **state that in the UI rather than showing a wrong number**.
_Depends on:_ P2.S1a. _Parallel with:_ P2.S2.
_Exit:_ AC 2.2 AC2 (visual differentiation in history, not by color alone); full keyboard operability with visible focus; the chart has a table equivalent.
_Reviewers:_ `accessibility-copy-reviewer`, `code-reviewer`.

**P2.S4 — Seed generator, first scenario (S) — `fhir-data-modeler` authors, `devops-deployment-engineer` wires**
`packages/seed` per D6, with `stable-ileostomy` only. Deterministic seed, relative-to-now timestamps, wired into `dev-reset`.

> **GATE B — the first demonstrable milestone.** On the dev host, in one live walkthrough: a phone in airplane mode logs a stoma output and the save confirms instantly; reconnecting syncs it; an audit row carries before/after; a forced conflict puts the loser in the audit log; an intentionally invalid queued operation is rejected server-side and surfaces in the correction inbox rather than disappearing; the web view renders the entry with its Measured/Estimated badge.
>
> Every hard seam in this system — sync, conflict, idempotency, offline validation re-enforcement, audit coverage on the sync path — is now exercised, while it is still cheap to change.

### P3 — Remaining entry types and the configuration surface

| Sprint    | Size | Owner                                                     | Goal                                                                                                                                                                                                                                                 | Spec / AC                   |
| --------- | ---- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **P3.S1** | M    | `expo-mobile-developer` + `nestjs-api-developer` (serial) | Fluid intake and meals. Meals are app-native (table + quick-tag value set); intake needs the fluid-type value set and quick-select container sizes.                                                                                                  | §3.1, AC 2.3, AC 2.4        |
| **P3.S2** | M    | `expo-mobile-developer` + `nestjs-api-developer` (serial) | Voided urine: same Measured/Estimated contract, the pale-to-dark color scale **with a text label on every step**, color-without-volume as a valid entry, and **exclusion from Daily Net Fluid Balance**.                                             | §3.7, AC 12.1 AC1–AC4       |
| **P3.S3** | M    | `nestjs-api-developer` + `fhir-data-modeler`              | `/api/v1/admin/...` config API at final shape: value sets (retire, never delete), default range tables, validation thresholds. Separate guard, separate audience, every change audit-logged. **No UI yet** — seeded by migration, changed by script. | §3.11, §5.2, D5             |
| **P3.S4** | S    | `expo-mobile-developer`                                   | Quick-Add widgets generated from the patient's own recent entries. Must resolve on tap with **no loading state**.                                                                                                                                    | §3.1, Epic 3                |
| **P3.S5** | S    | `fhir-data-modeler`                                       | Remaining seed scenarios except `leak-cluster` (deferred to P5, when leak entities exist): `high-output-dehydration`, `new-post-op`, `colostomy-baseline`, `validation-edge-cases`.                                                                  | `deployment-development.md` |

**Note on exit criteria:** SRS §7 has no acceptance criteria for Epics 3–11, 15, or 16 — the spec says so explicitly and calls it a backlog-refinement task. **P3.S4 and everything in P5 therefore have no spec-given AC.** Before dispatching those sprints, the main session must either write AC into the spec or accept looser, agent-negotiated exit criteria. Recommend the former for P5.S2 (physician view) and P5.S6 (export), which are the two where "done" is genuinely ambiguous.

### P4 — Onboarding, preferences, suggested ranges

_This is where the app becomes usable by a real patient._

| Sprint    | Size | Owner                                                       | Goal                                                                                                                                                                                                                                                                       | Spec / AC             |
| --------- | ---- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **P4.S1** | M    | `expo-mobile-developer`, then `react-web-developer`         | Onboarding: **only three mandatory fields** (ostomy type, surgery date, measurement system), everything else skippable with deferred prompts. Surgery date becomes the Tier 1 lower timestamp bound.                                                                       | §3.0, Epic 7          |
| **P4.S2** | M    | `nestjs-api-developer` + `react-web-developer` (core logic) | Suggested ranges: seeded from clinical defaults keyed to ostomy type and time since surgery; pre-filled with plain-language basis; **an unconfirmed suggestion is never an active threshold**; adaptation proposed, never silent; physician-set values never auto-changed. | §3.9, AC 14.1 AC1–AC4 |
| **P4.S3** | M    | `expo-mobile-developer` + `react-web-developer`             | Preferences area covering everything §3.10 lists; preference changes queue through the sync path like any other write and propagate via delta.                                                                                                                             | §3.10, Epic 15        |
| **P4.S4** | S    | `react-web-developer`                                       | Measurement-system switch re-renders all history in the new units **without rewriting stored canonical values**.                                                                                                                                                           | §3.10, D9             |

> **GATE C — usable core.** A patient onboards in three fields, logs output/intake/urine/meals offline, adjusts preferences and targets, and a clinician reads a correct physician view for two of the four hydration signals.
>
> **Two things must also happen at this gate, and both are easy to skip:**
>
> 1. **The §5.1 performance spike** — establish real p95 save latency, cold start, and 30–90 day history load numbers, so §5.1's directional statements can become testable targets at P9.
> 2. **A staging spike** (see Risk R2). A minimal Fargate + real-Cognito + TLS proof, not full staging. Deferring all parity risk to P9 concentrates it at the worst possible moment.

### P5 — History, physician view, exports, appliance/skin, medications, reminders

_Largely parallelizable across agents once P4 lands, but each is a separate dispatch and a separate review._

| Sprint    | Size | Owner                                                                  | Goal                                                                                                                                                                                                                                                                                                 |
| --------- | ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P5.S1** | M    | `expo-mobile-developer` + `react-web-developer`                        | History: filter/search by category; edit and delete with the §3.6 audit trail (original + corrected value).                                                                                                                                                                                          |
| **P5.S2** | M    | `react-web-developer`                                                  | Physician view proper: chronological overlays (morning/afternoon/evening/night) with medication times, intake, output, appliance and skin events; anomaly highlighting against effective ranges with provenance shown. **Signals stay separate.**                                                    |
| **P5.S3** | M    | `expo-mobile-developer` + `nestjs-api-developer` + `fhir-data-modeler` | Appliance changes with auto-calculated wear time, leak events with severity and cause tags, peristomal skin severity, photos via **short-lived presigned URLs with path-style addressing** and **no patient identifier or clinical value in the object key**. Plus the `leak-cluster` seed scenario. |
| **P5.S4** | M    | `nestjs-api-developer` + `expo-mobile-developer`                       | Medications: RxNorm lookup, patient-friendly term mapping, RXCUI storage in `medication_administrations`. _Blocked on D4's RxNorm subset/API question._                                                                                                                                              |
| **P5.S5** | M    | `expo-mobile-developer` + `nestjs-api-developer`                       | Reminders: medication, adaptive appliance-change, hydration nudges; quiet hours; per-category enable/disable; push behind the adapter (Expo in production, log-only in dev).                                                                                                                         |
| **P5.S6** | M    | `fhir-data-modeler` + `nestjs-api-developer`                           | FHIR R4 `Bundle` export module, PDF generation, and read-only expiring scoped share links. Plus the §3.6 full personal-history export, which is a distinct artifact from the physician summary.                                                                                                      |

### P6 — Weight and composite hydration status (SRS Phase 5)

| Sprint    | Size | Owner                                                        | Goal                                                                                                                                                                                                                          | AC              |
| --------- | ---- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **P6.S1** | S    | `fhir-data-modeler` + `expo-mobile-developer`                | Weight as an observation (LOINC 29463-7), `method` **unpopulated**, **no Measured/Estimated toggle**, one decimal place, unit from the measurement system. Absolute bounds Tier 1; day-over-day change Tier 2.                | AC 17.1 AC1–AC4 |
| **P6.S2** | M    | `react-web-developer` (core logic) + `expo-mobile-developer` | Rolling baseline tracking legitimate post-op recovery; physician-set dry weight takes precedence; time-of-day mismatch annotated rather than presented as change; patient-facing copy in **absolute terms**, never percent.   | AC 17.2 AC1–AC4 |
| **P6.S3** | M    | `react-web-developer` + `expo-mobile-developer`              | Composite hydration status on the patient dashboard (three signals at this point), always explainable with drill-down. **Physician view keeps them separate.** Disabling weight removes it cleanly while history is retained. | AC 17.3 AC1–AC4 |

### P7 — Resting heart rate, concordance, red flag (SRS Phase 6)

| Sprint    | Size | Owner                                           | Goal                                                                                                                                                                                                                                                                                                                                                 | AC              |
| --------- | ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **P7.S1** | M    | `fhir-data-modeler` + `expo-mobile-developer`   | HR observation (LOINC 8867-4), measurement source and resting-conditions as **coded components**; non-resting readings stored and displayed but **excluded from baseline via a queryable flag, not by omitting rows**; absolute bounds Tier 1.                                                                                                       | AC 18.1 AC1–AC3 |
| **P7.S2** | M    | `expo-mobile-developer`                         | Orthostatic pair as two linked observations, **postural rise derived not stored**; safety guidance shown **every time the flow starts**, not once at setup.                                                                                                                                                                                          | AC 18.2 AC1–AC3 |
| **P7.S3** | M    | `react-web-developer` + `expo-mobile-developer` | Concordance escalation with the agreeing signals named; a single outlier informs without dominating; **the red-flag prompt routed entirely outside the validation path** — the entry saves normally with no data-quality warning; the red-flag threshold not patient-adjustable; the beta-blocker caveat in both patient- and physician-facing copy. | AC 18.3 AC1–AC5 |
| **P7.S4** | S    | `expo-mobile-developer`                         | The **single** combined daily check-in reminder covering weight and heart rate, subject to quiet hours — not a second notification type.                                                                                                                                                                                                             | §3.4            |

> **GATE D — four signals live.** Composite status is concordance-driven and explainable; the physician view keeps all four separate; the red flag is visually and behaviorally distinct from every validation warning. `accessibility-copy-reviewer` review of P7.S3 is **blocking** — the distinctness of the red-flag voice is the one thing in this system that is a patient-safety property carried entirely by copy.

### P8 — Admin console

| Sprint    | Size | Owner                 | Goal                                                                                                                                                                                                                                                |
| --------- | ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P8.S1** | S    | `react-web-developer` | `apps/admin` scaffold: separate identity pool config, MFA enforced, wired into the compose stack's `admin` service. The P0.S1 import-boundary lint rule now becomes load-bearing — it must **fail the build** if any patient data type is imported. |
| **P8.S2** | M    | `react-web-developer` | Value-set management with **retire, never delete**; retired members still resolve in historical rendering.                                                                                                                                          |
| **P8.S3** | M    | `react-web-developer` | Default range tables and validation threshold editing, every change audit-logged with admin identity and before/after.                                                                                                                              |

> **GATE E.** An administrator changes a soft-warning threshold in the console and the next patient entry is governed by the new value **with no application release** — AC 13.2 AC2 satisfied end to end for the first time.

### P9 — Staging parity gate, hardening, pre-launch

| Sprint    | Size | Owner                            | Goal                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ---- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P9.S1** | M    | `devops-deployment-engineer`     | AWS CDK: staging account, Fargate/ECS, RDS PostgreSQL Multi-AZ, S3 with SSE-KMS, S3+CloudFront for both SPAs (admin network-restricted), Cognito with **two disjoint pools**, Secrets Manager, private subnets with only the LB edge internet-facing.                                                                                                                                    |
| **P9.S2** | M    | `devops-deployment-engineer`     | **Clear the deferred-risk list in `docs/deployment-development.md` item by item**: Fargate orchestration semantics, TLS and secure cookie flags and HSTS, real Cognito token lifetimes / refresh rotation / MFA / hosted-UI flows / email flows, KMS and SSE-KMS, Multi-AZ failover, and a **backup/DR rehearsal actually measured against RPO ≤ 24h and RTO ≤ 4h** rather than assumed. |
| **P9.S3** | S    | `devops-deployment-engineer`     | Observability: CloudWatch logs/metrics/alarms against the 99.9% target; Sentry with `beforeSend` redaction, bodies and breadcrumbs off; restricted access to the audit store.                                                                                                                                                                                                            |
| **P9.S4** | M    | `nestjs-api-developer` + clients | Convert the Gate C spike results into §5.1 numeric targets and test against them.                                                                                                                                                                                                                                                                                                        |
| **P9.S5** | —    | **Not engineering**              | BAA execution; PHI retention period and deletion SLA from counsel; breach-notification procedure and a designated Security/Privacy Officer; third-party penetration test; RxNorm/SNOMED license confirmation; **the §5.4 pre-launch usability review with representative patients** — which automated WCAG scanning does not substitute for.                                             |

> **GATE F — production eligible.** Every item on the deferred-risk list cleared; every P9.S5 artifact signed off. **Production is the only environment permitted to hold real PHI, and only after this gate.**

---

## 5. Delegation and collaboration model

### 5.1 The structural constraint that shapes everything below

Subagents **start with a fresh context window every invocation and cannot dispatch each other**. The main session is the only coordinator. This has one hard consequence:

> **Anything that must survive between two agent invocations has to be in a file. The main session's conversation is not a durable channel.**

Durable state, by kind:

| State                              | Lives in                                                  | Read by                       |
| ---------------------------------- | --------------------------------------------------------- | ----------------------------- |
| Settled decisions                  | `design-specs/decisions/NNNN-*.md`                        | every agent, every invocation |
| Sync wire contract                 | `docs/sync-contract.md` + `packages/core/src/sync/`       | API, mobile                   |
| Data contract                      | `apps/api/prisma/schema.prisma` + generated Prisma client | API, seed                     |
| API contract                       | generated OpenAPI → typed client in `packages/core`       | web, mobile, admin            |
| Validation, units, hydration logic | `packages/core`                                           | API, web, mobile              |
| Terminology status and open codes  | `design-specs/data-model/fhir-rxnorm-integration.md`      | data modeler, API             |
| Test conventions                   | `docs/testing.md`                                         | every builder                 |
| Real commands                      | `docs/getting-started.md`                                 | every builder                 |

If a decision is made in conversation and not written to one of these, the next agent invocation will not know it and will re-decide it differently. That is the primary failure mode of this execution model.

### 5.2 Ownership, and resolving the `packages/core` conflict

`react-web-developer`'s charter claims `packages/core`, but `nestjs-api-developer` and `expo-mobile-developer` both consume it and will both want to change it mid-sprint. Left unresolved, the validation rules get forked three ways — which is exactly what "defined once in `packages/core`" (§3.8) exists to prevent.

**Recommendation (proposal — worth a short ADR):** partition `packages/core` by author, and make it read-only to everyone else.

| Path                                                  | Authored by                                                   | Everyone else |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------- |
| `packages/core/src/{validation,units,hydration,i18n}` | `react-web-developer`                                         | read-only     |
| `packages/core/src/fhir`                              | `fhir-data-modeler` (owns terminology)                        | read-only     |
| `packages/core/src/sync`                              | `nestjs-api-developer` (owns the server side of the contract) | read-only     |
| `packages/core/src/api-client`                        | **generated from OpenAPI; never hand-edited by anyone**       | generated     |

**Conflict procedure:** an agent that needs a change in a path it does not own **stops and reports the need** rather than editing. The main session dispatches a separate S-sized sprint to the owning agent, then re-dispatches the blocked sprint. This costs an extra round trip and is worth it — the alternative is two agents silently diverging a shared rule between invocations that cannot see each other.

### 5.3 Handoff artifacts

| Producer → Consumer                          | Handoff artifact                                                             | Sufficient when                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `fhir-data-modeler` → `nestjs-api-developer` | Committed `schema.prisma` + applied migration + the written coverage note    | Prisma client generates and the migration applies to a populated DB |
| main session → `nestjs-api-developer`        | `docs/sync-contract.md` + the accepted ADR                                   | Contract merged **before** sync code                                |
| `nestjs-api-developer` → both clients        | Generated OpenAPI + typed client committed to `packages/core/src/api-client` | Client compiles against the running API                             |
| `react-web-developer` → both clients         | `packages/core` validation + unit types + i18n catalog, with tests           | Both apps can inject thresholds and get typed block/warn results    |
| `devops-deployment-engineer` → everyone      | Working compose stack + real commands in `docs/getting-started.md`           | An agent can bring the stack up from the doc alone                  |
| any builder → reviewers                      | The branch diff                                                              | PR open, CI green                                                   |

### 5.4 Serial vs. parallel dispatch

**Strictly serial (do not parallelize):**

- P1.S3 (schema) → P1.S5 (audit/threshold service) → P2.S1 (slice API)
- P2.S0 (sync contract) → P2.S1b (sync endpoints) → P2.S2b (mobile sync)
- Any API endpoint → the client consuming it (the generated client is the gate)

**Safe to dispatch in parallel from the main session:**

- P1.S2 (dev stack), P1.S3 (schema), P1.S4 (core kernel) — after P1.S1
- P2.S2 (mobile) ∥ P2.S3 (web) — after P2.S1a
- Within P5: S1 / S3 / S4 / S5 / S6 touch largely disjoint modules
- Within P3: S1 ∥ S2 after their shared schema migration lands

**Never parallel, for boundary reasons rather than dependency:** an `apps/web` sprint and an `apps/admin` sprint must not be dispatched in the same invocation or to the same agent instance.

### 5.5 Reviewer cadence

All three reviewers are read-only by design. **They report; the main session applies fixes.** Never ask a reviewer to fix what it found.

| Reviewer                      | Runs on                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `code-reviewer`               | **Every sprint, without exception.**                                                                                                                                                                                     |
| `hipaa-compliance-reviewer`   | Any sprint touching PHI paths, audit logging, auth or authorization, logging or error tracking, seed/test data, infrastructure, or the admin boundary. **Blocking on P1.S5, P2.S1, P3.S3, P5.S3, P8.S1, and all of P9.** |
| `accessibility-copy-reviewer` | Any sprint producing user-facing UI or strings. **Blocking on P2.S2b, P2.S3, P3.S2 (the color scale), P6.S2 (absolute-terms copy), and P7.S3 (red-flag distinctness).**                                                  |

Run reviewers on the diff before merge, not after. With one human reviewer, the reviewer agents are the pre-screen that makes the human review tractable — which is the load-bearing assumption of this whole execution model.

### 5.6 What every delegation prompt must carry

1. **The sprint ID and its one-sentence goal.**
2. **The exact file paths in scope**, and the paths explicitly out of scope (especially `packages/core` sub-paths the agent does not own).
3. **The contract files to read first** — the relevant ADRs, `docs/sync-contract.md`, the Prisma schema, `docs/testing.md`.
4. **The SRS §7 acceptance criteria by ID** that constitute exit. Where none exist (Epics 3–11, 15, 16), say so and state the exit criteria explicitly instead.
5. **Which cross-cutting requirements apply.**
6. **Which reviewers will run**, so the agent builds toward them.

`CLAUDE.md` loads automatically and the agent definitions deliberately do not restate project rules — so the dispatch must not either. Add sprint-specific context only.

### 5.7 Roster gaps this plan will hit

| Gap                                                    | Assessment                                                                                                                                                                    | Recommendation                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No test-strategy agent**                             | Manageable. `docs/testing.md` (D2) written before P0 gives every builder the same conventions, and `code-reviewer` checks coverage of what changed.                           | **Do not add one now.** Revisit at Gate C.                                                                                                                                                                                                                                                                                         |
| **No `apps/admin` owner beyond `react-web-developer`** | **The most concerning gap.** The same agent owning both the patient web app and the zero-PHI admin console is precisely the boundary-blurring risk §3.11 makes architectural. | **Do not add a separate agent.** Instead: (a) admin sprints are **never** dispatched in the same invocation as a patient-web sprint; (b) `hipaa-compliance-reviewer` runs on **every** admin sprint; (c) the P0.S1 import-boundary lint rule fails the build, so the boundary is enforced by tooling and not by an agent's memory. |
| **No performance agent**                               | Correct to omit — §5.1 defers numeric targets pending the spike.                                                                                                              | Add at P9.S4 **only if** the Gate C spike produces targets that are not being met.                                                                                                                                                                                                                                                 |
| **No coordinator agent**                               | Correctly omitted.                                                                                                                                                            | The main session is the lead. The cost is that context discipline (§5.6) is entirely manual.                                                                                                                                                                                                                                       |

---

## 6. Cross-cutting requirements — what the _first_ sprint touching each must do

| Concern                            | First sprint                                   | What that sprint must do so it is never retrofitted                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audit logging**                  | **P1.S5, before any PHI endpoint exists**      | Ship the interceptor and the `AuditContext` _before_ the first write endpoint, so coverage is structural. Integration test: a PHI write without an audit row **fails**. No `UPDATE`/`DELETE` grant on `audit_events`. The sync path and the conflict loser both route through the same context — those are the two that get missed. |
| **i18n externalization**           | **P0.S1 (lint rule) + P1.S4 (catalog)**        | The `no-literal-string` ESLint rule exists before the first screen, not after. One shared catalog in `packages/core/i18n/`. All date/time/number/unit formatting through `Intl` helpers from the first render, even though v1 is English-only.                                                                                      |
| **Unit preference**                | **P1.S4**                                      | Canonical mL/kg types defined before the first observation is stored (D9). Conversion is render-time only. Make mixed-system states unrepresentable in the type, not merely unselectable in the UI.                                                                                                                                 |
| **Accessibility**                  | **P2.S3 (`packages/ui` primitives)**           | The shared primitives carry accessible names, label association, focus indication, and minimum touch-target sizing **in the component**, so every later screen inherits them. `accessibility-copy-reviewer` runs on the slice, not first at P8.                                                                                     |
| **Admin/patient boundary**         | **P0.S1 (lint rule) + P1.S1 (separate guard)** | The import-boundary rule exists at P0 even though `apps/admin` does not. `AdminJwtAuthGuard` is structurally separate from `JwtAuthGuard` from P1.S1 — never a shared guard with a role check. The boundary is an identity-layer property (§4.6).                                                                                   |
| **AGPL header**                    | **P0.S1**                                      | Enforced by lint, failing CI. Never by memory.                                                                                                                                                                                                                                                                                      |
| **No real PHI outside production** | **P1.S2 + P2.S4**                              | `.env.example` carries placeholders only; a CI check rejects a committed `.env`. The seed generator is deterministic and synthetic by construction (D6).                                                                                                                                                                            |
| **Never log PHI**                  | **P1.S1**                                      | Pino configured with body logging off and a scrubbing serializer at skeleton time. Validation errors return field identifiers and rule IDs, **never the offending clinical value**. Sentry `beforeSend` redaction lands with the first client, not at P9.                                                                           |
| **Thresholds as configuration**    | **P1.S4 + P1.S5**                              | The validation engine takes thresholds as injected data. There is no code path where a numeric bound is a constant. This is what makes AC 13.2 AC2 satisfiable at Gate E without rewriting the validation layer.                                                                                                                    |

---

## 7. Risks

**R1 — The sync engine is the hardest thing in this system.** Offline queue ordering, per-operation idempotency, last-write-wins against skewed device clocks, tombstone propagation, server-side re-enforcement of validation on untrusted queued payloads, and rejected-operation retention with a correction path — all interacting.
_Earliest visible:_ Gate B. Fully visible only at Gate C with two devices and real preference sync.
_Mitigation:_ the contract is written and ADR'd before any code (P2.S0); the slice exists specifically to stress it; P2.S1 is split so sync gets its own reviewable diff.

**R2 — Staging is the parity gate, and P9 concentrates every deferred risk at the end.** Fargate orchestration, TLS, real Cognito (token lifetimes, refresh rotation, MFA, hosted UI, email flows), KMS, Multi-AZ, and DR are all untested until staging exists.
_Earliest visible:_ P9.S2 — far too late for a Cognito claim-shape surprise to be cheap.
_Mitigation, and the strongest structural recommendation in this plan:_ **pull a staging spike forward to Gate C.** A minimal Fargate task + a real Cognito pool + TLS, proving only that the OIDC adapter's claim mapping works against real Cognito and that the container runs under Fargate's health-check semantics.

**R3 — Single-human review bandwidth.** Every sprint produces a diff one person must read and accept.
_Earliest visible:_ the first sprint where review is deferred rather than done.
_Mitigation:_ the S/M/L discipline; the three reviewer agents as a pre-screen; a standing rule that any sprint estimated L is split before dispatch, not during review.

**R4 — `packages/ui` sharing between React Native and web may not pay off.** React Native Web is the assumed bridge (§4.2 says "where feasible"), and forced sharing produces components worse on both platforms than two honest implementations.
_Earliest visible:_ P2.S3.
_Mitigation:_ treat `packages/ui` initially as **design tokens + web components**, with cross-platform sharing proven on two or three primitives before committing. Decide by Gate C, and write the ADR either way.

**R5 — The SNOMED estimation-technique code is unresolved, and a wrong guess is invisible until export.**
_Earliest visible:_ P5.S6 at the earliest, realistically at first EHR integration.
_Mitigation:_ the single-constant discipline in D4. Never a plausible-looking number.

**R6 — Missing acceptance criteria for Epics 3–11, 15, 16.** SRS §7 states this openly.
_Earliest visible:_ P3.S4, acutely at P5.S2 and P5.S6.
_Mitigation:_ write AC into the spec before dispatching those two, or accept explicitly-stated looser exit criteria in the dispatch itself.

**R7 — Configuration-driven thresholds are load-bearing much earlier than the console that manages them.**
_Earliest visible:_ the first threshold change on the dev host (likely P3.S2).
_Mitigation:_ build the admin API at its final shape at P3.S3; ship a maintenance script alongside it.

---

## 8. Findings — outside the plan, for decision

**F1 — RESOLVED (SRS v2.4).** AC 17.3 AC 2 read _"net fluid balance, urine output, and weight appear as **three** distinct signals"_ — Phase 6 added resting heart rate to §3.5, §3.12 and `CLAUDE.md` but never updated the criterion, and it was the only AC asserting that the physician view keeps signals separate. Corrected to four signals.

**F2 — RESOLVED ([ADR-0005](../decisions/0005-decimal-volumetric-entry-and-conversion-rounding.md), SRS v2.4).** Volume fields accept positive decimals; stored values keep their entered precision; a volume converted between measurement systems is rounded to the nearest whole unit for **display only**. **Weight is excluded** and keeps one decimal place in both systems — rounding a converted weight to a whole unit would discard exactly the sub-kilogram day-over-day changes §3.12 exists to detect. AC 2.1 AC 1 rewritten, AC 2.1 AC 4 added.

**F3 — A stale reference.** `design-specs/data-model/fhir-rxnorm-integration.md` line 3 cites `Ostomy_App_Specification_v1.pdf` as "the SRS." `CLAUDE.md` is explicit that the PDF is historical reference only. Worth a one-line fix at P1.S3.

**F4 — Nothing in SRS §4 was re-opened.** Every architecture decision there is treated as settled. Where this plan proposes something the spec does not cover, it is labeled `[GAP]` and carries a recommendation rather than an assumption.
