-- P1.S3 schema core — initial migration.
--
-- HAND-AUTHORED, not `prisma migrate dev` output, for two reasons: the
-- runtime-role creation and its grants (ADR-0011) have to live in a
-- migration, not only in infra/db/bootstrap-roles.sql, because
-- Testcontainers-based integration tests (ADR-0002) start their own
-- ephemeral Postgres and never see infra/docker-compose.yml's `db-roles`
-- step (see infra/db/README.md "The seam for P1.S3" for the history); and
-- the shared cross-table sync-sequence assignment (ADR-0001) needs a
-- Postgres trigger and a standalone sequence, neither of which
-- schema.prisma has a declarative attribute for.
--
-- The table/enum/index/FK DDL below (everything between "CreateSchema" and
-- "AddForeignKey", inclusive) IS what
-- `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`
-- generates from prisma/schema.prisma verbatim, with three hand-added
-- exceptions Prisma has no declarative attribute for in this schema
-- version — the three `CHECK` constraints on `observations`
-- (`observations_resource_type_check`,
-- `observations_value_quantity_value_positive_check`,
-- `observations_value_quantity_unit_check`). If you ever suspect this file
-- has drifted from schema.prisma, regenerate the base DDL with that exact
-- command, diff it against this file with those three CHECKs removed, and
-- reconcile by editing schema.prisma first — never by hand-patching just
-- one of the two files.
--
-- Everything from "Sync sequence" onward (the sequence itself, the
-- sync-sequence assignment trigger, the value-set-member code-immutability
-- trigger, and the runtime role/grants) is hand-authored and permanently
-- outside what any `prisma migrate diff`/`migrate dev` invocation should
-- ever be asked to regenerate — see each section's own comment for why, and
-- B1/S5 in the P1.S3 review response
-- (design-specs/data-model/p1-s3-schema-coverage.md "Sync sequence
-- assignment" and "Role split") for the verification this design is based
-- on.
--
-- ============================================================================
-- IMPORTANT — do not run `prisma migrate dev` against a database this
-- migration has been applied to, and do not regenerate this file with
-- `prisma migrate diff --from-config-datasource --to-schema` as a way to
-- "check for drift" against a LIVE, migrated database (as opposed to an
-- EMPTY one, which is what the paragraph above means). Verified against a
-- real Postgres 17 container while fixing B1 in the P1.S3 review response:
-- before this fix, the equivalent live-database diff proposed
-- `DROP SEQUENCE "sync_sequence"` plus stripping the `server_sequence`
-- column default on all three tables that carry one, because the original
-- design used `@default(dbgenerated("nextval('sync_sequence')"))` in
-- schema.prisma, and Prisma's diff engine cannot match that string against
-- Postgres's own canonicalized `nextval('sync_sequence'::regclass)` — so it
-- concluded the sequence and every default referencing it were unmanaged
-- drift to remove. Applying that generated script would have silently
-- destroyed the ADR-0001 delta cursor for every existing row.
--
-- The fix (this file, and schema.prisma's `serverSequence` fields): the
-- Prisma-visible column default is now a trivial, diff-safe literal
-- (`DEFAULT 0`) that Prisma fully understands and never touches. The REAL
-- assignment happens in the `assign_sync_sequence()` trigger below, which
-- Prisma's diff engine does not model at all (triggers are simply outside
-- what it inspects) and therefore never proposes to drop. A live-database
-- diff against the CURRENT state of this migration is clean — see the
-- coverage note referenced above for the verification transcript. It will
-- stay clean only as long as nobody reintroduces a `dbgenerated()` default
-- referencing `sync_sequence` on any of these three columns.
-- ============================================================================
--
-- Split of responsibility for the runtime role, per ADR-0011's suggested
-- resolution and verified against a real Testcontainers Postgres while
-- writing this migration:
--   - THIS migration owns the role's EXISTENCE, its ATTRIBUTES, and every
--     GRANT it holds. All three are safe to commit — a role name, its
--     attribute flags, and a set of privileges are not secrets — and all
--     three must be identical in dev, CI/Testcontainers, staging, and
--     production.
--   - The role is created NOLOGIN. No password is set here, and none ever
--     will be: a password is a secret, and this file is committed.
--   - infra/db/bootstrap-roles.sql (run by the `db-roles` Compose service,
--     now AFTER `migrate` rather than before — see that file and
--     infra/docker-compose.yml) is the ONLY thing that ever runs
--     `ALTER ROLE ... WITH LOGIN PASSWORD ...`, from POSTGRES_RUNTIME_PASSWORD
--     in .env, never committed.
--   - A Testcontainers integration test never sees bootstrap-roles.sql
--     either, so it must run the equivalent one-line `ALTER ROLE ... WITH
--     LOGIN PASSWORD ...` itself, as the owner connection, with its own
--     throwaway per-test password, before it can connect as the runtime
--     role at all. See apps/api/src/prisma/prisma.integration.spec.ts.
--
-- Consequence worth naming explicitly: because a migration is static SQL
-- with no equivalent of psql's client-side `-v` substitution, the runtime
-- role's NAME (unlike its password) can no longer be supplied at deploy
-- time — it is the literal identifier 'ostomy_runtime' below, matching the
-- default in .env.example and infra/docker-compose.yml. If
-- POSTGRES_RUNTIME_USER is ever changed from that default, this migration
-- must be updated to match (a new, additive migration that renames the
-- role — never edit an already-applied one). Before this change, the role
-- name was a runtime parameter to bootstrap-roles.sql; that flexibility is
-- what this design gives up in exchange for Testcontainers visibility.
--
-- B3 (P1.S3 review response): unlike the role's existence, its attributes
-- were previously asserted only inside the `IF NOT EXISTS` guard's TRUE
-- branch — a role that already existed (e.g. the shared dev host's `pgdata`
-- volume, provisioned under an earlier single-superuser model per
-- infra/db/README.md) kept whatever attributes it already had, and every
-- GRANT below is decorative against a superuser, which bypasses privilege
-- checks entirely. The unconditional `ALTER ROLE` immediately after the `DO`
-- block below closes that: it runs every time, regardless of whether the
-- role was just created or already existed, and forces the six
-- non-superuser attributes onto it either way.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ostomy_type" AS ENUM ('COLOSTOMY', 'ILEOSTOMY');

-- CreateEnum
CREATE TYPE "measurement_system" AS ENUM ('METRIC', 'IMPERIAL');

-- CreateEnum
CREATE TYPE "observation_status" AS ENUM ('registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown');

-- CreateEnum
CREATE TYPE "sync_entity_type" AS ENUM ('PROFILE', 'OBSERVATION', 'EFFECTIVE_RANGE');

-- CreateEnum
CREATE TYPE "sync_operation_type" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "sync_operation_status" AS ENUM ('ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('PATIENT', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "value_set_member_status" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "validation_tier" AS ENUM ('TIER_1_HARD_BLOCK', 'TIER_2_SOFT_WARNING', 'SAFETY_THRESHOLD', 'OPERATIONAL');

-- CreateEnum
CREATE TYPE "range_provenance" AS ENUM ('PHYSICIAN_SET', 'PATIENT_SET', 'PATIENT_CONFIRMED_SUGGESTION', 'CLINICAL_DEFAULT');

-- CreateEnum
CREATE TYPE "range_status" AS ENUM ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'DISMISSED');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "oidc_subject" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "ostomy_type" "ostomy_type" NOT NULL,
    "surgery_date" DATE NOT NULL,
    "measurement_system" "measurement_system" NOT NULL,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL DEFAULT 'Observation',
    "code" TEXT NOT NULL,
    "value_quantity_value" DECIMAL(12,4) NOT NULL,
    "value_quantity_unit" TEXT NOT NULL,
    "effective_datetime" TIMESTAMPTZ(3) NOT NULL,
    "method" TEXT,
    "status" "observation_status" NOT NULL DEFAULT 'final',
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id"),
    -- Structural, not clinical: mirrors the FHIR wire shape (this table is
    -- exclusively Observation resources), it is not a stand-in for any
    -- Tier 1/Tier 2 validation rule. Those stay admin-managed configuration
    -- read by packages/core and the API (P1.S4/P1.S5), never a DB CHECK.
    CONSTRAINT "observations_resource_type_check" CHECK ("resource_type" = 'Observation'),
    -- Defense in depth for the part of Tier 1 that is structural and
    -- permanent for every code this migration currently covers (stoma
    -- output, fluid intake, voided urine, body weight — see the model's own
    -- doc comment in schema.prisma): a volume/weight cannot be zero or
    -- negative (SRS §3.8 Tier 1; ADR-0005). This is scoped to today's code
    -- set, not a universal claim about every row this table will ever hold
    -- — SRS §3.8 itself allows "zero where a positive value is required" as
    -- a distinct case, and a later derived-observation feature (e.g. a
    -- computed balance) may legitimately need a zero or negative value.
    -- Widening this table to such a code is an additive migration that must
    -- revisit this CHECK, not assume it already accommodates the new case.
    CONSTRAINT "observations_value_quantity_value_positive_check" CHECK ("value_quantity_value" > 0),
    -- The canonical-unit half of ADR-0004 (S4, P1.S3 review response): a
    -- wrong unit is the failure mode that is silent everywhere else — every
    -- Daily Net Fluid Balance and weight-delta computation reading this row
    -- is simply wrong, with no error at any layer — whereas a negative
    -- volume is already caught by three layers before this CHECK would
    -- ever matter. Scoped to the two canonical units this migration's codes
    -- use; widen it in the same additive migration that adds a code needing
    -- a third unit.
    CONSTRAINT "observations_value_quantity_unit_check" CHECK ("value_quantity_unit" IN ('mL', 'kg'))
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "entity_type" "sync_entity_type" NOT NULL,
    "entity_id" UUID NOT NULL,
    "operation_type" "sync_operation_type" NOT NULL,
    "client_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "sync_operation_status" NOT NULL,
    "rejection_reason_code" TEXT,
    "rejection_field" TEXT,
    "applied_server_sequence" BIGINT,

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" VARCHAR(255) NOT NULL,
    "action" "audit_action" NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "reason_code" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "value_sets" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "value_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "value_set_members" (
    "id" UUID NOT NULL,
    "value_set_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "value_set_member_status" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "value_set_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_default_ranges" (
    "id" UUID NOT NULL,
    "ostomy_type" "ostomy_type" NOT NULL,
    "range_type" TEXT NOT NULL,
    "min_days_post_op" INTEGER,
    "max_days_post_op" INTEGER,
    "low_value" DECIMAL(12,4),
    "high_value" DECIMAL(12,4),
    "unit" TEXT NOT NULL,
    "window_days" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinical_default_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_thresholds" (
    "id" UUID NOT NULL,
    "threshold_key" TEXT NOT NULL,
    "tier" "validation_tier" NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "unit" TEXT,
    "patient_adjustable" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "validation_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effective_ranges" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "range_type" TEXT NOT NULL,
    "low_value" DECIMAL(12,4),
    "high_value" DECIMAL(12,4),
    "target_value" DECIMAL(12,4),
    "unit" TEXT NOT NULL,
    "provenance" "range_provenance" NOT NULL,
    "status" "range_status" NOT NULL DEFAULT 'ACTIVE',
    "previous_range_id" UUID,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "effective_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_oidc_subject_key" ON "patients"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_patient_id_key" ON "profiles"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_server_sequence_key" ON "profiles"("server_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "observations_server_sequence_key" ON "observations"("server_sequence");

-- CreateIndex
CREATE INDEX "observations_patient_id_code_effective_datetime_idx" ON "observations"("patient_id", "code", "effective_datetime");

-- CreateIndex
CREATE INDEX "observations_patient_id_server_sequence_idx" ON "observations"("patient_id", "server_sequence");

-- CreateIndex
CREATE INDEX "sync_operations_patient_id_client_timestamp_idx" ON "sync_operations"("patient_id", "client_timestamp");

-- CreateIndex
CREATE INDEX "sync_operations_entity_type_entity_id_idx" ON "sync_operations"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_operations_patient_id_operation_id_key" ON "sync_operations"("patient_id", "operation_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "value_sets_key_key" ON "value_sets"("key");

-- CreateIndex
CREATE UNIQUE INDEX "value_set_members_value_set_id_code_key" ON "value_set_members"("value_set_id", "code");

-- CreateIndex
CREATE INDEX "clinical_default_ranges_ostomy_type_range_type_idx" ON "clinical_default_ranges"("ostomy_type", "range_type");

-- CreateIndex
CREATE UNIQUE INDEX "validation_thresholds_threshold_key_key" ON "validation_thresholds"("threshold_key");

-- CreateIndex
CREATE UNIQUE INDEX "effective_ranges_server_sequence_key" ON "effective_ranges"("server_sequence");

-- CreateIndex
CREATE INDEX "effective_ranges_patient_id_range_type_status_idx" ON "effective_ranges"("patient_id", "range_type", "status");

-- CreateIndex
CREATE INDEX "effective_ranges_patient_id_server_sequence_idx" ON "effective_ranges"("patient_id", "server_sequence");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observations" ADD CONSTRAINT "observations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "value_set_members" ADD CONSTRAINT "value_set_members_value_set_id_fkey" FOREIGN KEY ("value_set_id") REFERENCES "value_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effective_ranges" ADD CONSTRAINT "effective_ranges_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "effective_ranges" ADD CONSTRAINT "effective_ranges_previous_range_id_fkey" FOREIGN KEY ("previous_range_id") REFERENCES "effective_ranges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sync sequence (ADR-0001)
-- One sequence shared by every synced entity table's `server_sequence`
-- column (profiles, observations, effective_ranges — see each column's
-- `@default(0)` placeholder in schema.prisma, and the trigger immediately
-- below for the REAL assignment), so a cursor value from one table is
-- comparable against a cursor value from another: the delta endpoint
-- (P2.S1b, not built yet) can merge changes across entity types into one
-- strictly increasing stream. Must exist before the trigger function below
-- references it.
CREATE SEQUENCE "sync_sequence" AS BIGINT;

-- Sync sequence assignment trigger (ADR-0001; B1, P1.S3 review response)
--
-- HAND-AUTHORED — like the runtime role/grants section further below, this
-- must never be something `prisma migrate diff`/`migrate dev` is asked to
-- regenerate. See this file's own header comment for the full "why", and
-- design-specs/data-model/p1-s3-schema-coverage.md "Sync sequence
-- assignment" for the empirical verification.
--
-- Replaces the original design's per-column
-- `DEFAULT nextval('sync_sequence')`, which made every column carrying it
-- look like unmanaged drift to Prisma's migration-diffing engine (see above)
-- and — independently of that bug — only ever fired on INSERT, silently
-- relying on P2.S1b's future write path to remember to call `nextval()`
-- again on every UPDATE (including a tombstone soft-delete) by convention.
-- This trigger fires on both, unconditionally, and overwrites whatever
-- value the application supplied (including the schema's own placeholder
-- `DEFAULT 0`) — so "an UPDATE must re-assign server_sequence" is
-- mechanically true regardless of what P2.S1b's write path does or forgets.
CREATE OR REPLACE FUNCTION assign_sync_sequence() RETURNS TRIGGER AS $$
BEGIN
  NEW.server_sequence := nextval('sync_sequence');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "profiles_assign_sync_sequence"
BEFORE INSERT OR UPDATE ON "profiles"
FOR EACH ROW EXECUTE FUNCTION assign_sync_sequence();

CREATE TRIGGER "observations_assign_sync_sequence"
BEFORE INSERT OR UPDATE ON "observations"
FOR EACH ROW EXECUTE FUNCTION assign_sync_sequence();

CREATE TRIGGER "effective_ranges_assign_sync_sequence"
BEFORE INSERT OR UPDATE ON "effective_ranges"
FOR EACH ROW EXECUTE FUNCTION assign_sync_sequence();

-- Known, documented, NOT fixed here (C4 — flagged in the P1.S3 review
-- response as the requester's own item, not this migration's job to solve):
-- `nextval()` above still runs at statement execution time, inside the
-- transaction, before commit — moving the assignment from a column DEFAULT
-- into this trigger does not change that. Two concurrent writes can still
-- take sequence values 10 and 11, 11 can commit first, and a delta pull
-- ordered by `server_sequence` that runs between those two commits can
-- observe 11, advance its cursor past 10, and then never see 10 once it
-- does commit. See
-- design-specs/data-model/p1-s3-schema-coverage.md "Sync sequence
-- assignment" for this restated as a required P2.S1b constraint (a safe
-- watermark via `pg_snapshot_xmin`, or a transaction-scoped advisory lock)
-- rather than a schema-level fix.

-- audit_events.occurred_at server-set trigger (S3, P1.S3 review response —
-- REVISED from the review's literally-suggested mechanism; see below)
--
-- HAND-AUTHORED, same reason as the triggers above and below. The review
-- suggested enforcing "server-set, not merely server-defaulted" with a
-- column-scoped `GRANT INSERT` naming every column except `occurred_at`,
-- relying on Postgres applying `DEFAULT CURRENT_TIMESTAMP` when an INSERT
-- omits the column. Verified empirically against Prisma ORM 7's actual
-- generated client (query-compiler runtime, not the legacy Rust query
-- engine): `PrismaClient.auditEvent.create()` computes `@default(now())`
-- CLIENT-SIDE and sends `occurred_at` explicitly in every INSERT it issues
-- — including calls that omit it from `data`, which is precisely the
-- legitimate, ordinary case this grant shape needs to keep working. A
-- column-scoped grant excluding `occurred_at` would have rejected every
-- single `auditEvent.create()` call the generated client makes, not just a
-- deliberate backdating attempt — confirmed by running it against a real
-- Postgres 17 container and observing `permission denied for table
-- audit_events` on an ordinary, value-omitting create() call.
--
-- The trigger below achieves the review's actual intent — the STORED value
-- can never be influenced by caller-supplied input, full stop — through a
-- mechanism that does not depend on Prisma choosing to omit the column: it
-- unconditionally overwrites `NEW.occurred_at` with `now()` before every
-- INSERT, regardless of what value the client sent (or didn't). This is
-- the same pattern as `assign_sync_sequence()` above, applied to the same
-- class of problem. The grant on this table is therefore ordinary
-- table-level `INSERT` (see further below) — no column list needed, since
-- the trigger, not the grant, is what makes `occurred_at` server-set.
CREATE OR REPLACE FUNCTION assign_audit_event_occurred_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_assign_occurred_at"
BEFORE INSERT ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION assign_audit_event_occurred_at();

-- Value-set-member code immutability trigger (S5, P1.S3 review response)
--
-- HAND-AUTHORED, same reason as the trigger above. "Retired, never
-- deleted" (SRS §3.11, CLAUDE.md) was previously enforced only by
-- application/admin-tool discipline; this makes the "never renumbered"
-- half of that rule mechanical. `UPDATE ... SET code = ...` is worse than a
-- DELETE here: it silently re-labels every historical clinical entry that
-- already referenced the old code, with no audit trail until admin-side
-- audit logging exists (P3.S3). Retiring a member (an ordinary
-- `UPDATE ... SET status = 'RETIRED', retired_at = now()`) is unaffected —
-- only a change to `code` itself is rejected.
CREATE OR REPLACE FUNCTION forbid_value_set_member_code_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.code IS DISTINCT FROM NEW.code THEN
    RAISE EXCEPTION 'value_set_members.code is immutable once created (retired, never deleted or renumbered) — old: %, new: %', OLD.code, NEW.code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "value_set_members_forbid_code_change"
BEFORE UPDATE ON "value_set_members"
FOR EACH ROW EXECUTE FUNCTION forbid_value_set_member_code_change();

-- Runtime role and grants (ADR-0011)
--
-- No `CREATE ROLE IF NOT EXISTS` in vanilla Postgres SQL (unlike
-- `CREATE TABLE IF NOT EXISTS`), and no psql `\gexec`/`:'var'` substitution
-- available to a file Prisma's migration engine executes directly (it is
-- not run through the `psql` client) — see infra/db/bootstrap-roles.sql's
-- own header comment for why THAT file used `\gexec`, and why that
-- approach cannot be reused here. A plain, portable `DO` block is the
-- idempotent equivalent that works through any Postgres client, including
-- Prisma's.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ostomy_runtime') THEN
    CREATE ROLE "ostomy_runtime" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOLOGIN;
  END IF;
END
$$;

-- B3 (P1.S3 review response): asserted UNCONDITIONALLY, every time this
-- migration runs — not only inside the `IF NOT EXISTS` guard's TRUE branch
-- above. A role's EXISTENCE and its ATTRIBUTES are two different facts:
-- the guard above only proves the role exists, never that a pre-existing
-- role (e.g. one carried over on the shared dev host's `pgdata` volume from
-- before this migration existed — see infra/db/README.md) actually holds
-- these six attribute flags. A role that is still, or somehow became, a
-- superuser bypasses every privilege check below, making every `GRANT`
-- statement in this file decorative. Running this every deploy is
-- idempotent and cheap; there is no correctness reason to skip it when the
-- role was "just created" a few lines up.
ALTER ROLE "ostomy_runtime" NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- No password set above and none ever will be here — see this file's
-- header comment. `db-roles` (infra/docker-compose.yml, now sequenced
-- AFTER `migrate`) and any integration test's own setup are the only
-- things that ever run `ALTER ROLE "ostomy_runtime" WITH LOGIN PASSWORD ...`.

-- `CONNECT`/`USAGE` are the only privileges granted unconditionally, per
-- ADR-0011's "no blanket ALTER DEFAULT PRIVILEGES" rule — every table
-- below is granted individually and explicitly. A future migration that
-- adds a table and forgets its own GRANT line produces "permission denied
-- for table X" the first time the API touches it: a loud failure, on
-- purpose, not a silent over-grant.
-- `GRANT ... ON DATABASE` needs a literal database name, not a function
-- call, in plain SQL — but the actual name varies by environment
-- (ostomy_dev in Compose, a Testcontainers-assigned name in CI/tests, a
-- future RDS database name in staging/production), so it cannot be a
-- literal in a migration that must run unmodified in all of them. A `DO`
-- block with `EXECUTE format(...)` is the portable way to grant against
-- `current_database()` dynamically.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO "ostomy_runtime"', current_database());
END
$$;
GRANT USAGE ON SCHEMA "public" TO "ostomy_runtime";

-- Ordinary, non-tombstoned tables: full CRUD. `patients` and
-- `sync_operations` are deliberately not part of the tombstone/DELETE
-- discipline below (S6) — neither is a synced, tombstoned entity under
-- ADR-0001 (see schema.prisma's `Patient.deletedAt` sibling comment on
-- `Profile.deletedAt`).
GRANT SELECT, INSERT, UPDATE, DELETE ON "patients" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync_operations" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "value_sets" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "clinical_default_ranges" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "validation_thresholds" TO "ostomy_runtime";

-- Tombstoned synced entities (ADR-0001): `DELETE` deliberately withheld
-- (S6, P1.S3 review response — reversed from this migration's original
-- grant, which gave these three full CRUD and relied on the P2.S1b write
-- path never issuing a hard DELETE by convention). Under ADR-0001 these
-- tables never legitimately need `DELETE` — not "shouldn't", never: every
-- removal is a soft `deleted_at` tombstone, which is an UPDATE. A hard
-- DELETE from any of these three produces no audit row (SRS §5.2) and no
-- tombstone for the delta-sync cursor to propagate, so a second device
-- would keep the row forever with no way to learn it was removed. A future
-- counsel-authorized erasure flow (the PHI retention/deletion policy still
-- pending per ADR-0001 "Notes") ships its own migration and runs as the
-- owner role, not the runtime role — the friction this omission creates is
-- the point, not a gap to close by adding DELETE back.
GRANT SELECT, INSERT, UPDATE ON "profiles" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE ON "observations" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE ON "effective_ranges" TO "ostomy_runtime";

-- value_set_members: retired, never deleted (SRS §3.11, CLAUDE.md) — `DELETE`
-- withheld the same way as the tombstoned tables above (S5), and paired
-- with the `forbid_value_set_member_code_change` trigger further up, which
-- covers the "never renumbered" half a grant alone cannot express (a grant
-- can withhold DELETE; it cannot distinguish "UPDATE the sort_order" from
-- "UPDATE the code out from under every historical reference to it").
GRANT SELECT, INSERT, UPDATE ON "value_set_members" TO "ostomy_runtime";

-- audit_events: append-only BY GRANT, not convention (ADR-0011, SRS §5.2).
-- No UPDATE, no DELETE, anywhere, ever, ordinary table template above
-- deliberately not used here. This is the specific grant the P1.S5
-- integration test exists to prove, and the reason ADR-0002 requires that
-- test to run against a real PostgreSQL rather than a mocked Prisma
-- client.
-- Ordinary table-level INSERT (S3, P1.S3 review response) — see the
-- `audit_events_assign_occurred_at` trigger above for why this is NOT the
-- column-scoped grant the review originally suggested: `occurred_at` being
-- server-set is enforced by that trigger unconditionally overwriting it,
-- not by withholding the column from this grant. A column-scoped grant
-- would reject Prisma's own generated `auditEvent.create()` calls, which
-- explicitly send a client-computed `occurred_at` value on every INSERT
-- (verified empirically) — including the ordinary case where application
-- code never set one.
GRANT SELECT, INSERT ON "audit_events" TO "ostomy_runtime";

-- The shared sync_sequence: the sync-sequence-assignment trigger above
-- calls nextval() as whichever role performed the INSERT/UPDATE (the
-- trigger function is not SECURITY DEFINER), so the runtime role needs
-- USAGE; SELECT lets it read the current value back if a write path ever
-- needs to (e.g. to populate SyncOperation.appliedServerSequence from
-- currval() in the same transaction).
GRANT USAGE, SELECT ON SEQUENCE "sync_sequence" TO "ostomy_runtime";
