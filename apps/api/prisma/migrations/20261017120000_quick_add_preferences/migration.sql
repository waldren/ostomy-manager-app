-- CreateEnum
CREATE TYPE "quick_add_decision" AS ENUM ('PINNED', 'HIDDEN', 'NONE');

-- AlterEnum
ALTER TYPE "sync_entity_type" ADD VALUE 'QUICK_ADD_PREFERENCE';

-- CreateTable
CREATE TABLE "quick_add_preferences" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "value_ml" DECIMAL(12,4),
    "method" VARCHAR(32),
    "fluid_type_code" VARCHAR(64),
    "urine_color_code" VARCHAR(64),
    "entered_measurement_system" "measurement_system" NOT NULL,
    "decision" "quick_add_decision" NOT NULL,
    "client_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "server_sequence" BIGINT NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quick_add_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quick_add_preferences_server_sequence_key" ON "quick_add_preferences"("server_sequence");

-- CreateIndex
CREATE INDEX "quick_add_preferences_patient_id_server_sequence_idx" ON "quick_add_preferences"("patient_id", "server_sequence");

-- AddForeignKey
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Everything below is hand-written. Prisma cannot know about any of it, and
-- each line is load-bearing rather than tidying.
-- ---------------------------------------------------------------------------

-- The shared sync sequence. Without this trigger every row keeps
-- `server_sequence` at its placeholder DEFAULT of 0 and the delta endpoint
-- never delivers a decision to another device (see the meals migration).
CREATE TRIGGER "quick_add_preferences_assign_sync_sequence"
BEFORE INSERT OR UPDATE ON "quick_add_preferences"
FOR EACH ROW EXECUTE FUNCTION assign_sync_sequence();

-- The routine's shape, as the observations it names are held to it. The push
-- path validates first (so a refusal is a named field, not a 500); these keep a
-- migration or a psql session from writing a routine no entry could have.
--
-- An absent volume is never zero, and only a colour-only urine routine has one.
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_volume_positive"
  CHECK ("value_ml" IS NULL OR "value_ml" > 0);
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_volumeless_is_urine_colour"
  CHECK ("value_ml" IS NOT NULL OR ("code" = '9187-6' AND "urine_color_code" IS NOT NULL));
-- Measured/Estimated qualifies a volume, so it goes with one, both ways.
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_method_with_volume"
  CHECK (("value_ml" IS NULL) = ("method" IS NULL));
-- A colour belongs to urine only; a fluid type to intake only.
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_colour_is_urine"
  CHECK ("urine_color_code" IS NULL OR "code" = '9187-6');
ALTER TABLE "quick_add_preferences" ADD CONSTRAINT "quick_add_preferences_fluid_type_is_intake"
  CHECK ("fluid_type_code" IS NULL OR "code" = '9000-1');

-- ADR-0011 grants. A new table is not covered by the init migration's grants.
-- `DELETE` is withheld: a decision is undone with NONE, never deleted, and a
-- hard DELETE would leave no tombstone for another device to learn from.
GRANT SELECT, INSERT, UPDATE ON "quick_add_preferences" TO "ostomy_runtime";
