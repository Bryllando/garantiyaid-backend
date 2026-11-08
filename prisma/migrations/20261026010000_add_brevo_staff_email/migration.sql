ALTER TABLE "staff_notifications"
  DROP CONSTRAINT "staff_notifications_email_provider_mode_check",
  ADD CONSTRAINT "staff_notifications_email_provider_mode_check"
    CHECK ("email_provider_mode" IN ('DISABLED', 'GMAIL_API', 'BREVO_API'));
