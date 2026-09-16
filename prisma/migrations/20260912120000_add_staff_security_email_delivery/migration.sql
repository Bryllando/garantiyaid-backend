ALTER TABLE "staff_notifications"
  ADD COLUMN "email_provider_mode" VARCHAR(20) NOT NULL DEFAULT 'DISABLED',
  ADD COLUMN "email_recipient" VARCHAR(150),
  ADD COLUMN "email_status" VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN "email_provider_reference" VARCHAR(120),
  ADD COLUMN "email_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "email_last_error_code" VARCHAR(60),
  ADD COLUMN "email_processing_token" UUID,
  ADD COLUMN "email_processing_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "email_sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "email_failed_at" TIMESTAMPTZ(6);

ALTER TABLE "staff_notifications"
  ADD CONSTRAINT "staff_notifications_email_provider_mode_check"
    CHECK ("email_provider_mode" IN ('DISABLED', 'GMAIL_API')),
  ADD CONSTRAINT "staff_notifications_email_status_check"
    CHECK ("email_status" IN ('NOT_REQUESTED', 'PENDING', 'SENT', 'FAILED')),
  ADD CONSTRAINT "staff_notifications_email_attempt_count_check"
    CHECK ("email_attempt_count" >= 0);

CREATE INDEX "staff_notifications_email_status_created_at_idx"
  ON "staff_notifications"("email_status", "created_at");
