# P1.S3 schema core — coverage note

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

`patients.id` is the OIDC `sub` claim (the same value
`PatientActor.id`/`JwtAuthGuard` already use), **not** a client-generated
UUID — see the model's own doc comment in `schema.prisma` for why this is
a deliberate departure from "every synced entity gets a client-generated
UUID primary key." `profiles` (ostomy type, surgery date, measurement
system) *is* a client-generated-UUID synced entity, one per patient
(`patient_id` is `@unique`).

### `sync_operations` / sync bookkeeping columns — ADR-0001

Per-operation-UUID idempotency table (storage only — the push/pull
handlers that populate and read it are P2.S1b's job). `profiles`,
`observations`, and `effective_ranges` each carry `client_updated_at`
(LWW ordering), `server_sequence` (the delta cursor, backed by one
cross-table Postgres `sync_sequence`), and `deleted_at` (tombstone).

### `audit_events` — SRS §5.2, ADR-0011

Append-only **by database grant**: the runtime role holds `SELECT`,
`INSERT` and nothing else on this table, anywhere, in any environment —
proved by `prisma.integration.spec.ts` against a real Testcontainers
Postgres. See "Role split" below for how the role itself is created
without ever committing its password.

### Configuration family — SRS §3.11

`value_sets` / `value_set_members` (retire-never-delete via `status`, not
deletion), `clinical_default_ranges`, `validation_thresholds`,
`effective_ranges` (provenance + `status` — see "Judgment calls" below for
how the "unconfirmed suggestion" rule is enforced).

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

## Judgment calls made without an ADR — flagged rather than decided silently

1. **`patients.id` = OIDC `sub`, not a client-generated UUID.** CLAUDE.md's
   rule is about *synced* entities (an offline device creates the row and
   needs to keep its identity across sync). The identity anchor itself is
   asserted by the IdP on every request, before any sync code runs, so it
   is not that kind of entity. Reasoned through in `schema.prisma`'s
   `Patient` doc comment. Worth an ADR if a future sprint wants to
   generalize "client-generated UUID" to mean something stronger.
2. **No grant-level enforcement of "value-set members are retired, never
   deleted."** ADR-0011 demands a *mechanical* grant-level guarantee
   specifically for `audit_events`; nothing analogous was asked for
   `value_set_members`, so none was invented. `value_set_members` gets the
   same full-CRUD grant as every other "ordinary" table; "retired, never
   deleted" is enforced by application/admin-tool discipline only. If the
   team wants the same mechanical guarantee ADR-0011 gives `audit_events`
   (revoke `DELETE`, or a `BEFORE DELETE` trigger that raises), that is a
   real, cheap option — recording it here rather than adding it silently,
   since it changes the grant model for a table this sprint's brief didn't
   name.
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
5. **`Observation`/`Profile`/`EffectiveRange` keep full `DELETE` in their
   grant**, unlike `audit_events`. Tombstone discipline (never a hard
   delete from application code) is a P2.S1b write-path concern, not
   something this migration mechanically forecloses. Named here so a
   reviewer can decide whether that residual risk is acceptable or
   warrants its own ADR later — not something to discover by noticing the
   grant statement in passing.

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
*is* the FHIR wire value, via the `@map`s in `schema.prisma`). An
estimated entry would additionally carry
`"method": { "coding": [{ "system": "http://snomed.info/sct", "code": "<TODO(code-unverified)>" }] }`
once that code is resolved. `medication_administrations` entries
(`MedicationAdministration` resources, RxNorm-coded) are not representable
yet — that table does not exist.
