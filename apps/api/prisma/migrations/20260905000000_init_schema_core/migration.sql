-- P1.S3 schema core — initial migration.
--
-- HAND-AUTHORED, not `prisma migrate dev` output, for one reason: the
-- runtime-role creation and its grants (ADR-0011) have to live in a
-- migration, not only in infra/db/bootstrap-roles.sql, because
-- Testcontainers-based integration tests (ADR-0002) start their own
-- ephemeral Postgres and never see infra/docker-compose.yml's `db-roles`
-- step. See infra/db/README.md "The seam for P1.S3" for the history.
--
-- The table/enum/index/FK DDL below (everything before "Sync sequence" and
-- "Runtime role and grants") IS what `prisma migrate diff --from-empty
-- --to-schema prisma/schema.prisma --script` generates from
-- prisma/schema.prisma verbatim — copy it back out and diff if you ever
-- suspect this file has drifted from the schema. Keep both in sync by
-- editing schema.prisma first and re-diffing, not by hand-patching just
-- one of them.
--
-- Split of responsibility for the runtime role, per ADR-0011's suggested
-- resolution and verified against a real Testcontainers Postgres while
-- writing this migration:
--   - THIS migration owns the role's EXISTENCE and every GRANT it holds.
--     Both are safe to commit — a role name and a set of privileges are
--     not secrets — and both must exist identically in dev, CI/Testcontainers,
--     staging, and production.
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

-- Sync sequence (ADR-0001)
-- One sequence shared by every synced entity table's `server_sequence`
-- column (profiles, observations, effective_ranges — see each column's
-- `@default(dbgenerated(...))` in schema.prisma), so a cursor value from
-- one table is comparable against a cursor value from another: the delta
-- endpoint (P2.S1b, not built yet) can merge changes across entity types
-- into one strictly increasing stream. Must exist before any table below
-- references it in a column DEFAULT.
CREATE SEQUENCE "sync_sequence" AS BIGINT;

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "patient_id" TEXT NOT NULL,
    "ostomy_type" "ostomy_type" NOT NULL,
    "surgery_date" DATE NOT NULL,
    "measurement_system" "measurement_system" NOT NULL,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT nextval('sync_sequence'),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observations" (
    "id" UUID NOT NULL,
    "patient_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL DEFAULT 'Observation',
    "code" TEXT NOT NULL,
    "value_quantity_value" DECIMAL(12,4) NOT NULL,
    "value_quantity_unit" TEXT NOT NULL,
    "effective_datetime" TIMESTAMPTZ(3) NOT NULL,
    "method" TEXT,
    "status" "observation_status" NOT NULL DEFAULT 'final',
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT nextval('sync_sequence'),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "observations_pkey" PRIMARY KEY ("id"),
    -- Structural, not clinical: mirrors the FHIR wire shape (this table is
    -- exclusively Observation resources), it is not a stand-in for any
    -- Tier 1/Tier 2 validation rule. Those stay admin-managed configuration
    -- read by packages/core and the API (P1.S4/P1.S5), never a DB CHECK.
    CONSTRAINT "observations_resource_type_check" CHECK ("resource_type" = 'Observation'),
    -- Defense in depth for the one part of Tier 1 that is genuinely
    -- structural and permanent, never admin-configurable, never
    -- overridable: a volume/weight/rate cannot be zero or negative
    -- (SRS §3.8 Tier 1; ADR-0005). Every other Tier 1/Tier 2 bound stays
    -- entirely in the admin-managed threshold tables — do not add another
    -- CHECK here for any of those.
    CONSTRAINT "observations_value_quantity_value_positive_check" CHECK ("value_quantity_value" > 0)
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" UUID NOT NULL,
    "patient_id" TEXT NOT NULL,
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
    "actor_id" TEXT NOT NULL,
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
    "patient_id" TEXT NOT NULL,
    "range_type" TEXT NOT NULL,
    "low_value" DECIMAL(12,4),
    "high_value" DECIMAL(12,4),
    "target_value" DECIMAL(12,4),
    "unit" TEXT NOT NULL,
    "provenance" "range_provenance" NOT NULL,
    "status" "range_status" NOT NULL DEFAULT 'ACTIVE',
    "previous_range_id" UUID,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT nextval('sync_sequence'),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "effective_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_patient_id_key" ON "profiles"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_server_sequence_key" ON "profiles"("server_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "observations_server_sequence_key" ON "observations"("server_sequence");

-- CreateIndex
CREATE INDEX "observations_patient_id_code_effective_datetime_idx" ON "observations"("patient_id", "code", "effective_datetime");

-- CreateIndex
CREATE INDEX "observations_server_sequence_idx" ON "observations"("server_sequence");

-- CreateIndex
CREATE INDEX "sync_operations_patient_id_client_timestamp_idx" ON "sync_operations"("patient_id", "client_timestamp");

-- CreateIndex
CREATE INDEX "sync_operations_entity_type_entity_id_idx" ON "sync_operations"("entity_type", "entity_id");

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

-- Ordinary tables: full CRUD. Tombstone discipline (never a hard DELETE
-- from application code) is enforced by the sync write path P2.S1b builds,
-- not by withholding DELETE at the grant level — unlike audit_events
-- below, nothing here demands a mechanical, grant-level guarantee, so none
-- is invented. See design-specs/data-model/p1-s3-schema-coverage.md for
-- the same reasoning applied to value_set_members' "retired, never
-- deleted" rule.
GRANT SELECT, INSERT, UPDATE, DELETE ON "patients" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "profiles" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "observations" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "sync_operations" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "value_sets" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "value_set_members" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "clinical_default_ranges" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "validation_thresholds" TO "ostomy_runtime";
GRANT SELECT, INSERT, UPDATE, DELETE ON "effective_ranges" TO "ostomy_runtime";

-- audit_events: append-only BY GRANT, not convention (ADR-0011, SRS §5.2).
-- No UPDATE, no DELETE, anywhere, ever, ordinary table template above
-- deliberately not used here. This is the specific grant the P1.S5
-- integration test exists to prove, and the reason ADR-0002 requires that
-- test to run against a real PostgreSQL rather than a mocked Prisma
-- client.
GRANT SELECT, INSERT ON "audit_events" TO "ostomy_runtime";

-- The shared sync_sequence: the runtime role calls nextval() on every
-- synced-entity write (via the column DEFAULT above, and again explicitly
-- on tombstone/update — P2.S1b), so it needs USAGE; SELECT lets it read
-- the current value back if a write path ever needs to (e.g. to populate
-- SyncOperation.appliedServerSequence from currval() in the same
-- transaction).
GRANT USAGE, SELECT ON SEQUENCE "sync_sequence" TO "ostomy_runtime";
