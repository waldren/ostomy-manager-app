# P1.S3 schema core — coverage note

**Updated after the P1.S3 code-reviewer/HIPAA-compliance-reviewer pass**
(review response commit, `sprint/p1-s3-schema-core`): the original migration
had a data-destroying Prisma-tooling bug (B1), a PHI log leak (B2), an
unenforced role-attribute guarantee (B3), no boot-time privilege
self-check (B4), a PK that should never have been the raw OIDC subject
(S1), and several under-enforced "never" rules (S4–S6) that are now
mechanically enforced. Every finding below is marked with its finding ID
and, where it changes a claim this document originally made, says so
explicitly rather than silently rewriting history. All of it was verified
against a real Postgres 17 container — see the sections below for the
transcripts and what they proved.

Handoff artifact for `nestjs-api-developer` at P2.S1a (named explicitly in
`design-specs/planning/v1-implementation-plan.md`'s P1.S3 exit criteria),
and for `fhir-data-modeler` at whichever sprint next touches
`apps/api/prisma/schema.prisma`. Read alongside
`design-specs/data-model/fhir-rxnorm-integration.md` (code sources) and
`apps/api/prisma/schema.prisma` itself (the schema is the source of truth;
this document explains it, not the other way around).

## What exists after this sprint

- `apps/api/prisma/schema.prisma` — the full data model.
- `apps/api/prisma/migrations/20260905000000_init_schema_core/migration.sql`
  — one hand-authored migration: every table below, plus the runtime
  database role and its grants (ADR-0011).
- `apps/api/prisma.config.ts` — Prisma ORM 7 CLI configuration (schema
  path, migrations path, owner-role datasource URL).
- `apps/api/src/prisma/prisma.service.ts` / `prisma.module.ts` — a
  ready-to-import `PrismaService`, **not yet wired into `AppModule`** (see
  below).
- `apps/api/src/prisma/prisma.integration.spec.ts` — Testcontainers-backed
  proof that the migration applies to an empty and a populated database,
  and that the runtime role can `SELECT`/`INSERT` but not
  `UPDATE`/`DELETE` `audit_events`.
- `infra/docker-compose.yml`'s `migrate` service now runs the real
  `prisma migrate deploy`; `db-roles` now runs after it (see "Role split"
  below).

## Tables, and which FHIR fields they cover

### `observations` — FHIR R4 `Observation`

| Column                  | FHIR field                        | Notes |
| ------------------------ | ---------------------------------- | ----- |
| `resource_type`          | `resourceType`                     | Always the literal `"Observation"`, enforced by a `CHECK` constraint. |
| `code`                   | `code.coding[0].code`              | LOINC. See `fhir-rxnorm-integration.md` for verified codes. The coding *system* (`http://loinc.org`) is not a column — every row in this table is LOINC-coded by construction, so there is nothing for a `code_system` column to distinguish yet. |
| `value_quantity_value`   | `valueQuantity.value`              | `NUMERIC(12,4)` — see "Numeric precision" below. |
| `value_quantity_unit`    | `valueQuantity.unit`               | Always `"mL"` or `"kg"` for the codes this migration covers (ADR-0004). Persisted per row despite being derivable from `code`, because FHIR requires it. |
| `effective_datetime`     | `effectiveDateTime`                | `TIMESTAMPTZ(3)`. |
| `method`                 | `method.coding[0].code`            | SNOMED CT "Estimation technique" code when estimated; NULL otherwise (measured, or not applicable — weight/heart rate). The exact SNOMED code is `TODO(code-unverified)`. |
| `status`                 | `status`                           | Full FHIR value set (`registered`…`unknown`), mapped via `@map` so the stored value is the literal FHIR wire string. |
| *(none — relational FK)* | `subject` (Reference to Patient)   | Modeled as an ordinary `patient_id` foreign key, not a FHIR `Reference` string — the accepted asymmetry of "FHIR-shaped relational, not FHIR-native" (SRS §4.4). The export module (not built yet) is what turns this FK into `subject: { reference: "Patient/<id>" }` on the wire. |
| *(none)*                 | `id` (the resource's own logical id) | `observations.id` doubles as this — it is the same client-generated UUID FHIR would use as the resource id. |

**Deliberately not in this table yet:** urine color as a coded
`component` (arrives with P3.S2's urine-color feature) and resting heart
rate's measurement-source / resting-conditions-met coded `component`s
(arrives whenever that feature is scheduled). Both are additive
`ALTER TABLE ... ADD COLUMN` migrations, not a redesign of this table, when
they land — see `fhir-rxnorm-integration.md`'s "Open questions".

**§3.7 rule this table's shape must not let anyone "fix" (named explicitly
here per the P1.S3 review response — this is the P2.S1a handoff artifact
and the omission was itself a finding):** voided urine output (`9187-6`)
lives in this same `observations` table, distinguished only by `code`, and
is **excluded from Daily Net Fluid Balance on purpose** — net balance
measures stoma losses, while urine output independently signals renal
perfusion, and summing them would let a normal-looking balance hide a
dangerously low urine output (CLAUDE.md, SRS §3.7). The index shape here
(`@@index([patientId, code, effectiveDatetime])`) makes `WHERE code <>
'9187-6'` the path of least resistance for whoever writes the first query
that sums stoma output — which is exactly the summing mistake this rule
forbids, arrived at by the natural, unremarkable route of "just exclude
the one I don't want," not by anyone deliberately breaking the rule. The
classification of which LOINC codes count as "stoma output" vs. "voided
urine" vs. "fluid intake" belongs in `packages/core` as one exported,
named set (ADR-0007) that both the Daily Net Fluid Balance calculation and
the urine-output-adequacy signal import from — not re-derived ad hoc at
each call site from `code` string literals.

**Codes verified vs. TODO** — see `fhir-rxnorm-integration.md` for sources:

- Verified: `79560-9` (stoma output), `9000-1` (fluid intake), `9187-6`
  (voided urine), `29463-7` (body weight, already cited in `CLAUDE.md`),
  `8867-4` (heart rate, already cited in `CLAUDE.md`, not yet written by
  any endpoint).
- `TODO(code-unverified)`: the SNOMED CT "Estimation technique" code for
  `method`. Do not invent one. `packages/core` (P1.S4) carries the same
  marker on `ESTIMATION_METHOD_CODE`.

### `medication_administrations` — not built

Out of scope for P1.S3 entirely (arrives with the medication feature). No
table, no columns, nothing to report.

### `patients` / `profiles` — SRS §3.0

**Reversed by S1 (P1.S3 review response).** `patients.id` is now a
server-generated UUID; the OIDC `sub` claim (the same value
`PatientActor.id`/`JwtAuthGuard` already use) lives in a separate
`oidc_subject` column, `@unique` and bounded at `VARCHAR(255)` (S2 — an
opaque, unvalidated bearer-token claim gets no unbounded-`TEXT` column).
This document previously defended making `patients.id` itself the raw
subject as a deliberate departure from "every synced entity gets a
client-generated UUID primary key," on the grounds that the identity
anchor is IdP-asserted, not client-generated, so that rule did not apply.
That reasoning about client-generated UUIDs was correct and still holds —
it just did not settle where the IdP's own subject belongs, and the
answer turned out to be "not the PK": see `schema.prisma`'s `Patient`
model doc comment for the full cost analysis (FK propagation into four
other tables, `audit_events.entity_id`, FHIR `subject.reference` handing
an IdP identifier to physicians, an IdP rebuild re-minting every `sub`
with no indirection to absorb it, and — the one that matters most given
ADR-0001's still-open PHI retention/deletion policy — de-identification
being a one-column `UPDATE` with a UUID PK versus a five-FK-column rewrite
with the subject as PK). `profiles` (ostomy type, surgery date,
measurement system) *is* a client-generated-UUID synced entity, one per
patient (`patient_id` is `@unique`, now `@db.Uuid` matching the new PK
type).

### `sync_operations` / sync bookkeeping columns — ADR-0001

Per-operation-UUID idempotency table (storage only — the push/pull
handlers that populate and read it are P2.S1b's job). `profiles`,
`observations`, and `effective_ranges` each carry `client_updated_at`
(LWW ordering), `server_sequence` (the delta cursor, backed by one
cross-table Postgres `sync_sequence`), and `deleted_at` (tombstone).

**Reversed by S7 (P1.S3 review response).** `sync_operations.id` is now a
server-generated surrogate key. The client-generated, per-operation UUID
(ADR-0001 point 1) lives in a separate `operation_id` column, scoped as
`@@unique([patientId, operationId])` rather than being globally unique on
its own. The original design made the client-chosen UUID the table's own
global PK directly — but that UUID is chosen by an untrusted, offline
device and is not inherently patient-scoped, so a colliding choice (buggy
or malicious) from patient A's device could cause patient B's distinct,
legitimate push to be rejected as a replay of A's. P2.S1b's push/pull
handler must look up an incoming operation by `(patientId, operationId)`
together, never by `operationId` alone — the composite unique index makes
the scoped lookup the natural one to write and a global one require going
out of your way.

**B1's sync-sequence-assignment fix, verified (see "Role split" below for
the full transcript):** `server_sequence` is no longer assigned by a
per-column `DEFAULT nextval('sync_sequence')` — that made every column
carrying it look like unmanaged drift to `prisma migrate diff`/`migrate
dev` (verified: it proposed `DROP SEQUENCE "sync_sequence"` plus stripping
the default on all three columns, against a live, already-migrated
database). Each of `profiles`, `observations`, and `effective_ranges` now
has a trivial, diff-safe `DEFAULT 0` in the Prisma schema, and a
hand-authored `BEFORE INSERT OR UPDATE` trigger (`assign_sync_sequence()`)
unconditionally overwrites it with the real `nextval('sync_sequence')`
value — which also mechanically enforces "an UPDATE must re-assign
`server_sequence`" (previously a P2.S1b convention to remember) since the
trigger fires on UPDATE too, regardless of what the application supplies.

### `audit_events` — SRS §5.2, ADR-0011

Append-only **by database grant**: the runtime role holds `SELECT`,
`INSERT` and nothing else on this table.

**Softened claim (B3/B4, P1.S3 review response):** this document
previously said that grant holds "anywhere, in any environment — proved
by `prisma.integration.spec.ts`." That overstated what the test actually
proves. `prisma.integration.spec.ts` proves the grant for the specific
role name `ostomy_runtime` in a Testcontainers-provisioned database that
this test suite always creates fresh. It does NOT prove — and cannot,
from inside a Testcontainers test — that a given deployed environment's
connected role is actually that constrained role rather than, say, a
pre-existing role with the same name but superuser attributes (see B3
immediately below), a misconfigured `DATABASE_URL` pointed at the owner
role, or a future migration that over-grants it. Two things now close
that gap instead:

- **B3**: the migration's `ALTER ROLE ... NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` now runs
  *unconditionally*, every deploy — not only inside the `IF NOT EXISTS`
  guard's `CREATE ROLE` branch. Verified against a real Postgres 17
  container: a role pre-elevated to `SUPERUSER` (simulating the shared dev
  host's `pgdata` volume, provisioned under an earlier single-superuser
  model per `infra/db/README.md`) has every attribute forced back to safe
  values the next time this migration runs, and holds no row in
  `pg_auth_members` (so it cannot `SET ROLE` into a role it was never
  granted membership in). `prisma.integration.spec.ts`'s
  `"holds NOSUPERUSER/.../NOBYPASSRLS and no role membership"` test
  asserts this directly.
- **B4**: `PrismaService.assertRuntimeRoleIsNotOverPrivileged()`
  (`apps/api/src/prisma/prisma.service.ts`) asserts the PROPERTY —
  `has_table_privilege('audit_events', 'UPDATE') OR
  has_table_privilege('audit_events', 'DELETE')` is false — rather than
  the role's name. This is what actually generalizes to staging and
  production: it catches a superuser runtime role (a superuser's own
  privilege-check bypass means `has_table_privilege` never returns `false`
  for it either, so this test doubles as a second, independent proof of
  the B3 property), a wrong DSN, a forgotten `ALTER`, or a future
  over-granting migration, in every environment this ever runs in.
  **Not yet wired into any boot sequence** — see `prisma.service.ts`'s own
  doc comment for why (the same "don't force an eager DB dependency onto
  every test that boots `AppModule`" reasoning that keeps `onModuleInit`
  lazy today) — and for what P1.S5/P2.S1a must do to actually call it
  once `PrismaModule` is part of `AppModule`'s graph.

See "Role split" below for how the role itself is created without ever
committing its password, and for the B1 verification transcript.

**Revised mechanism for `occurred_at` (S3, P1.S3 review response).** The
column is still server-set — the STORED value can never be influenced by
what a caller supplies — but not by the column-scoped `GRANT INSERT`
originally planned. Verified empirically against Prisma ORM 7's actual
generated client (the query-compiler runtime this repo uses, not the
legacy Rust query engine): `PrismaClient.auditEvent.create()` computes
`@default(now())` **client-side** and sends `occurred_at` explicitly on
every INSERT it issues, including calls that never set it in `data` — the
ordinary, ubiquitous case. A column-scoped grant excluding `occurred_at`
therefore rejected every legitimate `auditEvent.create()` call, not just a
deliberate backdating attempt, confirmed by running it against a real
Postgres 17 container. The fix instead mirrors `assign_sync_sequence()`:
a `BEFORE INSERT` trigger (`assign_audit_event_occurred_at`)
unconditionally overwrites `NEW.occurred_at` with `now()` regardless of
what the INSERT statement supplied. The grant on this table is therefore
ordinary, ungated `GRANT SELECT, INSERT` — no column list.

### Configuration family — SRS §3.11

`value_sets` / `value_set_members` (retire-never-delete via `status`, not
deletion — as of S5, P1.S3 review response, this is now ALSO mechanically
enforced: the runtime role's grant on `value_set_members` omits `DELETE`,
and a `BEFORE UPDATE` trigger, `forbid_value_set_member_code_change`,
raises if `OLD.code IS DISTINCT FROM NEW.code`, closing the "never
renumbered" half a missing `DELETE` grant alone cannot express — see
"Judgment calls" item 2 below, previously the open question this closes),
`clinical_default_ranges`, `validation_thresholds`, `effective_ranges`
(provenance + `status` — see "Judgment calls" below for how the
"unconfirmed suggestion" rule is enforced).

## Numeric precision (ADR-0005)

Every clinical decimal column is `NUMERIC(12, 4)` — 12 total digits, 4
fractional. Chosen over:

- **A bare `Decimal`** (Prisma's implicit default for PostgreSQL is
  `NUMERIC(65, 30)`) — a limit nobody chose on purpose, and not what "pick
  a numeric type with explicit precision and say why" means.
- **`Float`/`Double`** — binary floating point cannot represent 0.1 mL
  exactly, and ADR-0005 requires stored values to never be rounded; a
  value later summed into Daily Net Fluid Balance cannot carry that drift.

12/4 supports up to 99,999,999.9999 in canonical units (mL or kg) — far
beyond any plausible single entry or daily total — while remaining a
deliberate, reviewable bound.

**Qualified claim (docs finding, P1.S3 review response):** this document
and `schema.prisma`'s own comment both previously said NUMERIC's exact
base-10 arithmetic means "no entered precision is ever lost converting
to/from the wire," full stop. That is true only within scale 4 — a value
with more than 4 fractional digits (e.g. an intermediate calculation
feeding a future derived observation) is silently rounded to scale 4 at
this boundary (`1234.567891 -> 1234.5679`), which is exact WITHIN that
scale, not unbounded precision. Every write path this migration's own
codes currently need (patient-entered mL/kg values) is already at or
below 4 fractional digits, so this has not mattered yet; it will the
first time a derived-observation feature computes something
finer-grained than that and writes it here unrounded.

## Role split (ADR-0011) — resolved, not guessed at

The sprint prompt flagged a real tension: creating a role in a migration
needs `CREATEROLE`, and a role that logs in needs a password that must
never be committed. Verified against a real Testcontainers Postgres while
writing this migration:

- **The migration** creates `ostomy_runtime` `NOLOGIN`, idempotently (a
  `DO` block checking `pg_roles` — plain SQL has no
  `CREATE ROLE IF NOT EXISTS`, and a migration cannot use psql's
  `\gexec`/`:'var'` substitution the way `infra/db/bootstrap-roles.sql`
  used to), and grants it every table privilege it will ever hold. None of
  that is a secret, so all of it is safe to commit and identical across
  dev, CI/Testcontainers, staging, and production.
- **`infra/db/bootstrap-roles.sql`** (now run by Compose's `db-roles`
  service *after* `migrate`, reversed from before) does the one remaining
  thing: `ALTER ROLE ... WITH LOGIN PASSWORD ...`, from
  `POSTGRES_RUNTIME_PASSWORD` in `.env`, never committed.
- **A Testcontainers integration test** never sees `bootstrap-roles.sql`
  either. It runs the same one-line `ALTER ROLE` itself, as the owner
  connection, with a throwaway per-test password, before connecting as the
  runtime role. See `prisma.integration.spec.ts`.

**A real cost this design accepts, worth flagging explicitly:** because a
migration is static SQL with no equivalent of psql's client-side `-v`
substitution, the runtime role's *name* (unlike its password) can no
longer be supplied at deploy time — it is the literal identifier
`'ostomy_runtime'`, matching the existing `.env.example` default. Before
this change, the name was a runtime parameter; now, changing
`POSTGRES_RUNTIME_USER` requires a new, additive migration to match. This
is an inherent consequence of "role creation lives in a migration," not an
oversight — flagging it because ADR-0011 did not anticipate it, and a
future reader should not have to rediscover it by reading a failing
deploy log.

### B3 — the role's attributes are asserted unconditionally now, verified

The original migration only asserted `NOSUPERUSER NOCREATEDB NOCREATEROLE
NOINHERIT NOREPLICATION` inside the `IF NOT EXISTS` guard's `CREATE ROLE`
branch — a role that already existed (with any attributes at all) took
that branch's `ELSE`, and the migration reported success having verified
nothing. `infra/db/README.md` records that the shared dev host's `pgdata`
volume was provisioned under an earlier single-superuser model, so
`ostomy_runtime` likely already existed there — the guard's untested false
branch was not a hypothetical.

Fixed and verified against a real Postgres 17 container: an unconditional
`ALTER ROLE "ostomy_runtime" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
NOREPLICATION NOBYPASSRLS;` now runs immediately after the `DO` block,
every deploy, regardless of which branch it took. Transcript (abbreviated):

```
-- pre-existing role, manually elevated to simulate the guard's untested branch --
ALTER ROLE ostomy_runtime SUPERUSER;
 rolname        | rolsuper
 ostomy_runtime | t

-- re-running this migration's `migrate deploy` against that database --
Applying migration `20260905000000_init_schema_core`
All migrations have been successfully applied.

 rolname        | rolsuper | rolbypassrls
 ostomy_runtime | f        | f

-- pg_auth_members membership check --
 (0 rows)
```

`prisma.integration.spec.ts`'s `"holds NOSUPERUSER/.../NOBYPASSRLS and no
role membership"` test asserts the steady-state property (post-migration
attributes and no `pg_auth_members` row); Testcontainers always creates
the role fresh, so it cannot exercise the "pre-existing, wrongly-attributed
role" scenario the transcript above does — that scenario was verified by
hand, once, while fixing this, and is recorded here rather than re-run
automatically every CI run.

### B1 — sync-sequence assignment, and why the fix is a trigger, not a different default

Verified against a real Postgres 17 container: with the original design
(`server_sequence BigInt @unique
@default(dbgenerated("nextval('sync_sequence')"))` in `schema.prisma`),
`prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script` against a LIVE, already-migrated database
produced:

```sql
-- AlterTable
ALTER TABLE "effective_ranges" ALTER COLUMN "server_sequence" SET DEFAULT nextval('sync_sequence'),
ALTER COLUMN "server_sequence" DROP DEFAULT;
DROP SEQUENCE "sync_sequence";
-- (repeated for "observations" and "profiles")
```

Applying that generated script would have destroyed the ADR-0001 delta
cursor for every existing row, on the next sprint that ran `prisma migrate
dev` (which performs the equivalent diff internally to decide what a new
migration needs to contain) against this database. `--from-empty
--to-schema` (used to generate the original DDL in the first place) never
surfaces this, because there is no live database with a
`dbgenerated()`-vs-canonicalized-Postgres-string mismatch to diff against
in that direction — this is specifically a live-database-diff hazard.

Fix: `schema.prisma`'s three `server_sequence` fields now declare a
trivial `@default(0)` — a literal Prisma fully understands and never
treats as drift — and the REAL assignment happens in a hand-authored
`BEFORE INSERT OR UPDATE` trigger, `assign_sync_sequence()`, which
Prisma's diff engine does not model at all and therefore never proposes to
remove. Re-running the same diff against the fixed migration, on a live,
already-migrated database:

```
$ prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
-- This is an empty migration.

$ prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
No difference detected.
$ echo $?
0
```

`prisma.integration.spec.ts`'s `"re-diffing the live, migrated database
against schema.prisma is empty"` test runs this exact diff and pins the
empty result down permanently — a future schema change that reintroduces
a `dbgenerated()` `nextval()` default on any of these three columns will
fail that test with a non-empty diff, rather than the regression only
being caught the next time someone happens to run `migrate dev` by hand.

**C4 — known, NOT fixed by this trigger, and explicitly not this
migration's job to fix (flagged for P2.S1b, per the requester's own
scoping of this finding):** `nextval()` inside `assign_sync_sequence()`
still runs at statement-execution time, inside the transaction, before
commit — moving the assignment from a column `DEFAULT` into a `BEFORE`
trigger does not change *when* it runs relative to commit, only *how* the
value gets computed and *that* it also fires on UPDATE. Two concurrent
writes can still take sequence values 10 and 11, 11 can commit first, and
a delta pull ordered by `server_sequence` that runs between those two
commits observes 11, advances its cursor past 10, and then never
delivers 10 once it does commit — exactly the hazard ADR-0001 names. This
is a required constraint on whichever sprint builds the delta-pull
endpoint (P2.S1b): a safe watermark via `pg_snapshot_xmin()` (or
equivalent visibility-aware cursor), or a transaction-scoped advisory
lock serializing writers, not a schema-level fix.

## Judgment calls made without an ADR — flagged rather than decided silently

1. **RESOLVED by S1 (P1.S3 review response) — `patients.id` = OIDC `sub`,
   not a client-generated UUID.** This item originally defended that
   choice: CLAUDE.md's client-generated-UUID rule is about *synced*
   entities, the identity anchor is IdP-asserted rather than
   client-generated, so that rule did not apply — reasoning that was
   correct as far as it went, but did not settle where the IdP's own
   subject SHOULD live, only that it needn't be a client-generated UUID.
   Two independent reviewers flagged the PK choice itself on grounds this
   document had not considered (FK propagation into `audit_events` and
   every FHIR export's `subject.reference`, an IdP rebuild re-minting
   every `sub` with no indirection, and foreclosing de-identification while
   ADR-0001's PHI retention/deletion policy is still open with counsel).
   `patients.id` is now a server-generated UUID; `oidc_subject` is a
   separate, bounded, unique column. See `schema.prisma`'s `Patient` doc
   comment and the "`patients` / `profiles`" section above.
2. **RESOLVED by S5 (P1.S3 review response) — grant-level enforcement of
   "value-set members are retired, never deleted."** This item originally
   left it unenforced, reasoning that ADR-0011 asked for a *mechanical*
   grant-level guarantee specifically for `audit_events` and nothing
   analogous had been asked for `value_set_members`. The review asked for
   it anyway, and it is cheap: the runtime role's grant on
   `value_set_members` now omits `DELETE`, and a `BEFORE UPDATE` trigger
   (`forbid_value_set_member_code_change`) raises if `OLD.code IS DISTINCT
   FROM NEW.code` — the "never renumbered" half a missing `DELETE` grant
   alone cannot express, since `UPDATE ... SET code = ...` silently
   re-labels every historical entry that already referenced the old code,
   with no audit trail until admin-side audit logging exists (P3.S3). A
   compromised owner could disable the trigger; the threat model this
   closes is an application bug, not a compromised owner — the same
   distinction ADR-0011 already accepts for the grant half of
   `audit_events`'s own protection.
3. **`RangeStatus` (`PROPOSED` / `ACTIVE` / `SUPERSEDED` / `DISMISSED`) as
   the mechanism for "an unconfirmed suggestion is never an active anomaly
   threshold."** The alternative — inferring "confirmed" from provenance
   plus a nullable timestamp — was rejected because `PATIENT_CONFIRMED_SUGGESTION`
   already means "confirmed" by name, so a nullable-confirmation column on
   that same provenance value is a contradiction in terms waiting to
   confuse someone. `status = 'ACTIVE'` is the one thing anomaly flagging
   (not built yet) needs to filter on.
4. **No partial unique index enforcing "at most one `ACTIVE` row per
   `(patient_id, range_type)`" on `effective_ranges`.** Postgres supports
   this (`CREATE UNIQUE INDEX ... WHERE status = 'ACTIVE'`), and it would
   be cheap to add, but nothing in the SRS or an ADR confirms that
   invariant is actually meant to hold at the database level (vs.
   "whichever ACTIVE row has the highest-precedence provenance wins,
   possibly among several"). Left out rather than guessed at; flagging it
   as a candidate for whichever sprint builds the range-precedence query.
5. **RESOLVED by S6 (P1.S3 review response) — `Observation`/`Profile`/
   `EffectiveRange` no longer keep full `DELETE` in their grant.** This
   item originally accepted that residual risk, reasoning tombstone
   discipline was a P2.S1b write-path concern the schema did not need to
   foreclose mechanically. The review disagreed for these three
   specifically (`patients` and `sync_operations` are untouched — neither
   is a tombstoned, synced entity under ADR-0001): under ADR-0001 these
   three never legitimately need `DELETE`, not "shouldn't", never, so
   withholding it costs nothing and closes a real gap — a hard `DELETE`
   produces no audit row (SRS §5.2) and no tombstone for the delta-sync
   cursor to propagate, so a second device would keep a "deleted" row
   forever with no way to learn it was removed. The runtime role's grant
   on all three now omits `DELETE`.
6. **`sync_operations.id` was a globally unique, client-chosen PK —
   RESOLVED by S7 (P1.S3 review response), see the "`sync_operations`"
   section above.** The idempotency key comes from an untrusted, offline
   device and is not patient-scoped by construction; making it the
   table's global PK meant one patient's chosen operation id could collide
   with another's and cause a legitimate push to be rejected as a replay.
   Now a server-generated surrogate `id` plus a patient-scoped
   `@@unique([patientId, operationId])`.
7. **B1's fix trades a per-column `DEFAULT nextval()` for a shared
   `BEFORE INSERT OR UPDATE` trigger plus a same-named, unrelated literal
   `DEFAULT 0`.** The `0` is not a meaningful starting value in any sense
   — it exists purely so Prisma's diff engine has an ordinary, fully-typed
   default to match against and never flags the column as drift. Anyone
   reading a raw row before the trigger fires (there should never be a
   reason to) must not mistake a literal `0` for "unassigned" in the sense
   `NULL` usually means that; the column is `NOT NULL` and always
   trigger-overwritten before the row is visible to any transaction that
   didn't insert it. Recording this here because it is exactly the kind of
   "looks like a magic number" choice a future reader might try to
   "clean up" without realizing what it is protecting against.
8. **S3's fix for `audit_events.occurred_at` (a `BEFORE INSERT` trigger)
   changes the property being enforced in a subtle way worth naming.** The
   originally-planned column-scoped grant would have made an INSERT that
   named `occurred_at` fail outright — a loud, INSERT-time rejection. The
   trigger instead lets any INSERT succeed and silently overwrites
   whatever `occurred_at` value it carried. This is *more* permissive at
   the SQL level (no rejection) but *equally* strong at the property level
   (the stored value is never influenced by caller input) — and it is the
   only option compatible with Prisma ORM 7's client-computed defaults, as
   verified. Worth knowing if a future `$executeRaw` audit-log caller ever
   wonders why an intentionally-backdated debug insert "succeeded" but
   didn't do what it asked.

## Indexes (S8, P1.S3 review response)

`Observation` originally carried both a plain `@@index([serverSequence])`
and a `@@unique` on the same single column — strict write-cost overhead
with no read it served, since the unique index already answers any query
the plain index could. Replaced with `@@index([patientId,
serverSequence])` on both `Observation` and `EffectiveRange`, matching the
actual delta-pull read pattern (P2.S1b, not built yet): `WHERE patient_id
= $1 AND server_sequence > $cursor ORDER BY server_sequence`.

## Test infrastructure hardening (S9–S12, P1.S3 review response)

`prisma.integration.spec.ts` changed in four ways beyond the new
B1/B3/B4/S3/S4/S5/S6 assertions documented above:

- **S9**: a new test enumerates `information_schema.role_table_grants`
  for the runtime role and asserts it matches an explicit, reviewable
  expected-grants table (one entry per application table) exactly in both
  directions — a forgotten grant on a new table, or an accidental
  over-grant, both fail it — and separately asserts `_prisma_migrations`
  grants the runtime role nothing at all.
- **S10**: a missing Docker daemon now throws (failing the whole file to
  load) rather than silently skipping, whenever `process.env.CI` is set —
  the audit-immutability proof must never report green having proven
  nothing. Outside CI, the original clear-skip-with-message behavior is
  unchanged.
- **S11**: setting the runtime role's password and constructing the
  clients that use it moved from inside a same-named `it()` block into
  `beforeAll`, removing an implicit "tests 4 through *n* depend on test 3
  having already run, in order" assumption that the file's structure
  previously left unstated.
- **S12**: the subprocess-invoked `prisma migrate deploy` this test file
  runs now sets `MIGRATION_DATABASE_URL`, matching the rename in
  `apps/api/prisma.config.ts` and `infra/docker-compose.yml`'s `migrate`
  service (see "Two DSNs, one name" immediately below).

## Two DSNs, one name — renamed (S12, P1.S3 review response)

`apps/api/prisma.config.ts` (the CLI/migration datasource) and
`apps/api/src/config/env.schema.ts` (the running API's runtime datasource)
both read a variable named `DATABASE_URL`, distinguished only by which
process happened to read it — the `migrate` Compose service set it to the
owner DSN, the `api` Compose service set it to the runtime DSN, and both
names were literally `DATABASE_URL`. That is exactly the setup that lets a
developer's root `.env` — used for `pnpm --filter @ostomy/api start:dev`,
which also loads `.env` — silently run the entire API connected as the
schema owner, with none of ADR-0011's grant restrictions in effect, no
error, no warning, if that `.env` ever held the owner DSN under
`DATABASE_URL` for local migration convenience. `prisma.config.ts` now
reads `MIGRATION_DATABASE_URL` instead — a structurally different name
that copying a value from one file to the other cannot accidentally
collide with. `DATABASE_URL` (the runtime role's DSN) is unchanged.

## PHI log leak in the shared Postgres container (B2, P1.S3 review response)

Verified against a real Postgres 17 container: at the default
`log_error_verbosity`, a `CHECK` constraint violation writes a `DETAIL:`
line containing the full failing row — including the clinical value that
violated the constraint — to the container's own stdout, and therefore
into the `json-file` log driver `infra/docker-compose.yml` configures.
Before P1.S3 this container held no PHI-shaped tables, so the compose
file's comment asserting there was nothing to leak was true; it is false
now. Fixed with `command: ["postgres", "-c", "log_error_verbosity=terse"]`
on the `postgres` service, verified to suppress the `DETAIL:` line
entirely for the same violation that previously produced it. This is a
Compose-stack-specific mitigation — RDS has no equivalent flag, only a DB
parameter group's `log_error_verbosity` parameter, which staging and
production must set independently before real PHI reaches it; recorded as
a parity requirement in `docs/deployment-development.md`, not assumed
inherited.

## Built-artifact smoke check (B5, P1.S3 review response)

ADR-0010 already documents the exact failure shape this closes: a
`generatedFileExtension`/`importFileExtension` mismatch that typechecks
and unit-tests clean (Vitest's ESM transform never executes the emitted
CommonJS `require()` path) but throws `MODULE_NOT_FOUND` the moment the
*built* `dist/` output actually runs. Root `pnpm verify` previously had no
step that built the API and executed anything from `dist/`, so this class
of regression would have shipped through the PR gate. Added: `pnpm run
verify:build-artifact` (`pnpm --filter @ostomy/api build && node -e
"require('./apps/api/dist/prisma/prisma.service.js')"`), wired into `pnpm
verify`.

## Deliberately out of scope (arrives with its own feature, per the plan)

Appliance changes, leak events, peristomal skin condition, reminders,
Quick-Add templates, `medication_administrations`. Urine color and heart
rate coded components (see above). Seed data (P2.S4). The audit
interceptor and threshold service that actually *write* `audit_events` and
*read* `validation_thresholds`/`clinical_default_ranges` (P1.S5). Any
observation endpoint (P2.S1a). The FHIR export module itself.

## What a `Bundle` assembled from these tables would look like

Once the export module (not built yet) exists, a physician-view export for
one patient would assemble a `searchset` `Bundle` roughly like:

```json
{
  "resourceType": "Bundle",
  "type": "searchset",
  "entry": [
    {
      "resource": {
        "resourceType": "Observation",
        "id": "<observations.id>",
        "status": "final",
        "code": {
          "coding": [{ "system": "http://loinc.org", "code": "79560-9", "display": "Fluid output gastrointestinal ostomy [Volume] Measured" }]
        },
        "subject": { "reference": "Patient/<patients.id>" },
        "effectiveDateTime": "<observations.effective_datetime, ISO 8601>",
        "valueQuantity": {
          "value": "<observations.value_quantity_value>",
          "unit": "mL",
          "system": "http://unitsofmeasure.org",
          "code": "mL"
        }
      }
    },
    {
      "resource": {
        "resourceType": "Observation",
        "id": "<a body-weight observations.id>",
        "status": "final",
        "code": { "coding": [{ "system": "http://loinc.org", "code": "29463-7", "display": "Body weight" }] },
        "subject": { "reference": "Patient/<patients.id>" },
        "effectiveDateTime": "<...>",
        "valueQuantity": { "value": "<...>", "unit": "kg", "system": "http://unitsofmeasure.org", "code": "kg" }
      }
    }
  ]
}
```

Everything the `Bundle` needs for these two resource instances is a direct,
1:1 read off the `observations` row — no join beyond `patient_id` to build
`subject.reference`, and no translation table for `status` (the DB value
*is* the FHIR wire value, via the `@map`s in `schema.prisma`). Since S1,
`<patients.id>` in `subject.reference` above is a server-generated UUID,
not the patient's OIDC subject — the export module now has no path by
which an IdP-internal identifier could leak into a `Bundle` a physician
receives, which was not true of the original design. An
estimated entry would additionally carry
`"method": { "coding": [{ "system": "http://snomed.info/sct", "code": "<TODO(code-unverified)>" }] }`
once that code is resolved. `medication_administrations` entries
(`MedicationAdministration` resources, RxNorm-coded) are not representable
yet — that table does not exist.
