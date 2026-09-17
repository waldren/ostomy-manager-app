-- CreateEnum
CREATE TYPE "meal_size" AS ENUM ('SMALL', 'MEDIUM', 'LARGE');

-- AlterEnum
ALTER TYPE "sync_entity_type" ADD VALUE 'MEAL';

-- AlterTable
ALTER TABLE "observations" ADD COLUMN     "fluid_type_code" TEXT;

-- CreateTable
CREATE TABLE "meals" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "description" VARCHAR(2000),
    "size" "meal_size" NOT NULL,
    "tag_codes" TEXT[],
    "effective_datetime" TIMESTAMPTZ(3) NOT NULL,
    "entered_timezone" VARCHAR(64) NOT NULL,
    "local_date" DATE NOT NULL,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "meals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meals_server_sequence_key" ON "meals"("server_sequence");

-- CreateIndex
CREATE INDEX "meals_patient_id_effective_datetime_idx" ON "meals"("patient_id", "effective_datetime");

-- CreateIndex
CREATE INDEX "meals_patient_id_server_sequence_idx" ON "meals"("patient_id", "server_sequence");

-- CreateIndex
CREATE INDEX "meals_patient_id_local_date_idx" ON "meals"("patient_id", "local_date");

-- AddForeignKey
ALTER TABLE "meals" ADD CONSTRAINT "meals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "value_set_members" ADD COLUMN     "numeric_value" DECIMAL(12,4),
ADD COLUMN     "numeric_unit" TEXT;

-- ---------------------------------------------------------------------------
-- Everything below is hand-written. Prisma cannot know about any of it, and
-- each line is load-bearing rather than tidying.
-- ---------------------------------------------------------------------------

-- The shared sync sequence. `meals` is a SYNCED entity (ADR-0001), so it needs
-- the same BEFORE INSERT OR UPDATE trigger the other three synced tables have.
--
-- Without it every meal row keeps `server_sequence` at its column DEFAULT of
-- 0, and the consequences are silent: the delta endpoint orders by that
-- column, so meals would either all appear at the very beginning of a pull or
-- never advance a cursor past them, and §5.3's "no row is ever skipped"
-- invariant would be false for this entity type from the first row written.
-- The DEFAULT 0 in the table above is Prisma's placeholder, not the real
-- assignment — see the init migration's own comment on why the default is not
-- `nextval()` directly.
CREATE TRIGGER "meals_assign_sync_sequence"
BEFORE INSERT OR UPDATE ON "meals"
FOR EACH ROW EXECUTE FUNCTION assign_sync_sequence();

-- The dietary-trigger-analysis index (SRS §3.1). `tag_codes` is a text array
-- and the query it exists for is containment — "which meals carry this tag" —
-- which a btree cannot serve. GIN is the index type for that operator class.
--
-- Written here rather than as a Prisma `@@index(type: Gin)` because the
-- schema's own comment promises it and this is the only place it can actually
-- be expressed for an array column.
CREATE INDEX "meals_tag_codes_gin_idx" ON "meals" USING GIN ("tag_codes");

-- ADR-0011 grants. A new table is NOT covered by the init migration's grants,
-- and the init migration says exactly what happens when one is added without
-- them: "permission denied for table" at runtime, discovered by a request
-- handler rather than by this migration.
--
-- `DELETE` is deliberately withheld, matching the other tombstoned synced
-- entities. Under ADR-0001 a meal is never hard-deleted — every removal is a
-- soft `deleted_at` tombstone, which is an UPDATE. A hard DELETE would produce
-- no audit row and no tombstone for the delta cursor to propagate, so a second
-- device would keep the meal forever with no way to learn it was removed.
GRANT SELECT, INSERT, UPDATE ON "meals" TO "ostomy_runtime";

-- Value sets for the two new coded attributes, plus the quick-select container
-- sizes AC 2.3 AC2 requires be configurable.
--
-- Seeded by migration for the reason
-- `20260917000000_seed_default_validation_thresholds` records: these are
-- configuration every environment needs, not development data. An empty
-- `fluid_type` set means the intake screen renders an empty category list in
-- production.
--
-- `ON CONFLICT DO NOTHING` throughout, so a redeploy never resurrects a member
-- an admin retired. Retiring is a status change, and re-running this migration
-- must not undo it (CLAUDE.md: "Value-set members are retired, never deleted.
-- No admin action may change what a past entry means" — and neither may a
-- deploy).
INSERT INTO "value_sets" ("id", "key", "description", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'fluid_type', 'Categories offered when logging fluid intake (SRS AC 2.3 AC1). Optional on an entry.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'meal_tag', 'Optional quick-tags offered when logging a meal (SRS AC 2.4 AC1), for dietary trigger analysis.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'container_size', 'Quick-select container sizes that auto-fill the intake volume field (SRS AC 2.3 AC2). numeric_value is canonical mL.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Member CODES are stable identifiers, never display text: the label a patient
-- reads comes from the i18n catalog in packages/core (schema.prisma's ValueSet
-- comment is explicit that no display column may exist here, so there is one
-- localization pipeline rather than two). Every code below therefore needs a
-- matching catalog key before a screen can render it.
INSERT INTO "value_set_members" ("id", "value_set_id", "code", "status", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), vs."id", m."code", 'ACTIVE', m."sort_order", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "value_sets" vs
CROSS JOIN (VALUES
  ('water', 10),
  ('oral_rehydration_solution', 20),
  ('coffee_or_tea', 30),
  ('juice', 40),
  ('milk', 50),
  ('soup_or_broth', 60),
  ('other', 900)
) AS m("code", "sort_order")
WHERE vs."key" = 'fluid_type'
ON CONFLICT ("value_set_id", "code") DO NOTHING;

INSERT INTO "value_set_members" ("id", "value_set_id", "code", "status", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), vs."id", m."code", 'ACTIVE', m."sort_order", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "value_sets" vs
CROSS JOIN (VALUES
  ('high_fibre', 10),
  ('dairy', 20),
  ('high_sugar', 30),
  ('spicy', 40),
  ('high_fat', 50),
  ('alcohol', 60)
) AS m("code", "sort_order")
WHERE vs."key" = 'meal_tag'
ON CONFLICT ("value_set_id", "code") DO NOTHING;

-- The three container sizes AC 2.3 AC2 requires ("at least three"). Canonical
-- mL (ADR-0004), so an imperial patient sees them converted at render time and
-- the stored value never changes with a preference.
INSERT INTO "value_set_members" ("id", "value_set_id", "code", "status", "sort_order", "numeric_value", "numeric_unit", "created_at", "updated_at")
SELECT gen_random_uuid(), vs."id", m."code", 'ACTIVE', m."sort_order", m."ml", 'mL', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "value_sets" vs
CROSS JOIN (VALUES
  ('small_glass_200', 10, 200.0000),
  ('glass_250', 20, 250.0000),
  ('mug_350', 30, 350.0000),
  ('bottle_500', 40, 500.0000),
  ('large_bottle_750', 50, 750.0000)
) AS m("code", "sort_order", "ml")
WHERE vs."key" = 'container_size'
ON CONFLICT ("value_set_id", "code") DO NOTHING;
