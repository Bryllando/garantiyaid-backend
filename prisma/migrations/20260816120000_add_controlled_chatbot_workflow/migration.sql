-- Phase 10 adds controlled anonymous chatbot sessions, deterministic message
-- ordering, staff escalation ownership, explicit resolution, and retention
-- metadata. Existing Phase 1-9 data is preserved.
CREATE TYPE "ChatbotSessionStatus" AS ENUM (
  'ACTIVE',
  'ESCALATED',
  'RESOLVED',
  'ENDED'
);

ALTER TABLE "chatbot_sessions"
  ADD COLUMN "access_token_hash" VARCHAR(64),
  ADD COLUMN "status" "ChatbotSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "escalation_reason" VARCHAR(40),
  ADD COLUMN "escalated_at" TIMESTAMPTZ(6),
  ADD COLUMN "assigned_staff_id" UUID,
  ADD COLUMN "assigned_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolved_by_id" UUID,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "resolution_code" VARCHAR(40),
  ADD COLUMN "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "retention_until" TIMESTAMPTZ(6),
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "chatbot_sessions" AS session
SET
  "status" = CASE
    WHEN session."ended_at" IS NOT NULL THEN 'ENDED'::"ChatbotSessionStatus"
    WHEN session."is_escalated" THEN 'ESCALATED'::"ChatbotSessionStatus"
    ELSE 'ACTIVE'::"ChatbotSessionStatus"
  END,
  "escalation_reason" = CASE
    WHEN session."is_escalated" THEN 'LEGACY_ESCALATION'
    ELSE NULL
  END,
  "escalated_at" = CASE
    WHEN session."is_escalated" THEN session."started_at"
    ELSE NULL
  END,
  "last_activity_at" = COALESCE(
    (
      SELECT MAX(message."created_at")
      FROM "chatbot_messages" AS message
      WHERE message."session_id" = session."session_id"
    ),
    session."started_at"
  ),
  "retention_until" = session."created_at" + INTERVAL '90 days';

ALTER TABLE "chatbot_sessions"
  ALTER COLUMN "retention_until" SET NOT NULL,
  ADD CONSTRAINT "chatbot_sessions_language_check"
    CHECK ("language" IS NULL OR "language" IN ('en', 'fil', 'ceb')),
  ADD CONSTRAINT "chatbot_sessions_escalation_state_check"
    CHECK (
      "status" NOT IN ('ESCALATED', 'RESOLVED')
      OR (
        "is_escalated" = true
        AND "escalation_reason" IS NOT NULL
        AND "escalated_at" IS NOT NULL
      )
    ),
  ADD CONSTRAINT "chatbot_sessions_assignment_pair_check"
    CHECK (
      ("assigned_staff_id" IS NULL AND "assigned_at" IS NULL)
      OR ("assigned_staff_id" IS NOT NULL AND "assigned_at" IS NOT NULL)
    ),
  ADD CONSTRAINT "chatbot_sessions_resolution_state_check"
    CHECK (
      ("status" = 'RESOLVED' AND "resolved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL AND "resolution_code" IS NOT NULL AND "ended_at" IS NOT NULL)
      OR ("status" <> 'RESOLVED' AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL AND "resolution_code" IS NULL)
    ),
  ADD CONSTRAINT "chatbot_sessions_terminal_end_check"
    CHECK (
      ("status" IN ('RESOLVED', 'ENDED') AND "ended_at" IS NOT NULL)
      OR ("status" IN ('ACTIVE', 'ESCALATED') AND "ended_at" IS NULL)
    ),
  ADD CONSTRAINT "chatbot_sessions_retention_check"
    CHECK ("retention_until" > "created_at");

CREATE UNIQUE INDEX "chatbot_sessions_access_token_hash_key"
  ON "chatbot_sessions"("access_token_hash");
CREATE INDEX "chatbot_sessions_status_last_activity_at_idx"
  ON "chatbot_sessions"("status", "last_activity_at");
CREATE INDEX "chatbot_sessions_beneficiary_id_status_last_activity_at_idx"
  ON "chatbot_sessions"("beneficiary_id", "status", "last_activity_at");
CREATE INDEX "chatbot_sessions_assigned_staff_id_status_last_activity_at_idx"
  ON "chatbot_sessions"("assigned_staff_id", "status", "last_activity_at");
CREATE INDEX "chatbot_sessions_retention_until_idx"
  ON "chatbot_sessions"("retention_until");

ALTER TABLE "chatbot_sessions"
  ADD CONSTRAINT "chatbot_sessions_assigned_staff_id_fkey"
    FOREIGN KEY ("assigned_staff_id") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "chatbot_sessions_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chatbot_messages"
  ADD COLUMN "sequence" INTEGER,
  ADD COLUMN "staff_user_id" UUID;

WITH ranked_messages AS (
  SELECT
    "message_id",
    ROW_NUMBER() OVER (
      PARTITION BY "session_id"
      ORDER BY "created_at" ASC, "message_id" ASC
    ) AS message_sequence
  FROM "chatbot_messages"
)
UPDATE "chatbot_messages" AS message
SET "sequence" = ranked.message_sequence
FROM ranked_messages AS ranked
WHERE ranked."message_id" = message."message_id";

ALTER TABLE "chatbot_messages"
  ALTER COLUMN "sequence" SET NOT NULL,
  ADD CONSTRAINT "chatbot_messages_sequence_positive_check"
    CHECK ("sequence" > 0),
  ADD CONSTRAINT "chatbot_messages_confidence_bounds_check"
    CHECK ("confidence_score" IS NULL OR ("confidence_score" >= 0 AND "confidence_score" <= 1)),
  ADD CONSTRAINT "chatbot_messages_staff_sender_check"
    CHECK (
      ("sender_type" = 'STAFF' AND "staff_user_id" IS NOT NULL)
      OR ("sender_type" <> 'STAFF' AND "staff_user_id" IS NULL)
    );

ALTER TABLE "chatbot_messages"
  DROP CONSTRAINT "chatbot_messages_session_id_fkey";

ALTER TABLE "chatbot_messages"
  ADD CONSTRAINT "chatbot_messages_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "chatbot_sessions"("session_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "chatbot_messages_staff_user_id_fkey"
    FOREIGN KEY ("staff_user_id") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "chatbot_messages_session_id_sequence_key"
  ON "chatbot_messages"("session_id", "sequence");
CREATE INDEX "chatbot_messages_session_id_created_at_message_id_idx"
  ON "chatbot_messages"("session_id", "created_at", "message_id");
CREATE INDEX "chatbot_messages_staff_user_id_created_at_idx"
  ON "chatbot_messages"("staff_user_id", "created_at");

-- Automated low-confidence escalation has no authenticated staff actor. The
-- actor type makes that explicit while keeping every existing staff audit row.
ALTER TABLE "audit_logs"
  ALTER COLUMN "user_id" DROP NOT NULL,
  ADD COLUMN "actor_type" VARCHAR(20) NOT NULL DEFAULT 'STAFF',
  ADD CONSTRAINT "audit_logs_actor_check"
    CHECK (
      ("actor_type" = 'STAFF' AND "user_id" IS NOT NULL)
      OR ("actor_type" = 'SYSTEM' AND "user_id" IS NULL)
    );
