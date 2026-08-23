-- Phase 9 adds only operational metadata needed for simulated notification
-- delivery, deduplication, retry visibility, and scoped history queries.
ALTER TABLE "notifications"
  ADD COLUMN "distribution_id" UUID,
  ADD COLUMN "initiated_by" UUID,
  ADD COLUMN "provider_mode" VARCHAR(20) NOT NULL DEFAULT 'SIMULATED',
  ADD COLUMN "provider_reference" VARCHAR(80),
  ADD COLUMN "simulated" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deduplication_key" VARCHAR(64),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error_code" VARCHAR(50),
  ADD COLUMN "scheduled_for" TIMESTAMPTZ(6),
  ADD COLUMN "processing_token" UUID,
  ADD COLUMN "processing_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "failed_at" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "notifications_provider_reference_key"
  ON "notifications"("provider_reference");
CREATE UNIQUE INDEX "notifications_deduplication_key_key"
  ON "notifications"("deduplication_key");
CREATE INDEX "notifications_beneficiary_id_created_at_idx"
  ON "notifications"("beneficiary_id", "created_at");
CREATE INDEX "notifications_schedule_id_created_at_idx"
  ON "notifications"("schedule_id", "created_at");
CREATE INDEX "notifications_distribution_id_status_created_at_idx"
  ON "notifications"("distribution_id", "status", "created_at");
CREATE INDEX "notifications_status_scheduled_for_idx"
  ON "notifications"("status", "scheduled_for");
CREATE INDEX "notifications_notification_type_created_at_idx"
  ON "notifications"("notification_type", "created_at");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_distribution_id_fkey"
  FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_initiated_by_fkey"
  FOREIGN KEY ("initiated_by") REFERENCES "users"("user_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
