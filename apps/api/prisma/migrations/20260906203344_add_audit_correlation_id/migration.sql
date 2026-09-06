-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "correlation_id" VARCHAR(255);

-- CreateIndex
CREATE INDEX "audit_events_correlation_id_idx" ON "audit_events"("correlation_id");
