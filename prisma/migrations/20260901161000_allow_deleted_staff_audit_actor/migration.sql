ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_check";

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_actor_check"
  CHECK (
    ("actor_type" = 'STAFF' AND "user_id" IS NOT NULL)
    OR ("actor_type" IN ('SYSTEM', 'DELETED_STAFF') AND "user_id" IS NULL)
  );
