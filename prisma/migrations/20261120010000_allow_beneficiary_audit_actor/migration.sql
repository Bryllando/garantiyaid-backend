ALTER TABLE "audit_logs"
  DROP CONSTRAINT "audit_logs_actor_check",
  ADD CONSTRAINT "audit_logs_actor_check" CHECK (
    ("actor_type" = 'STAFF' AND "user_id" IS NOT NULL)
    OR ("actor_type" IN ('SYSTEM', 'DELETED_STAFF', 'BENEFICIARY') AND "user_id" IS NULL)
  );
