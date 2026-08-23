ALTER TABLE "users"
ADD COLUMN "last_totp_counter" BIGINT,
ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_failed_login_at" TIMESTAMPTZ(6),
ADD COLUMN "locked_until" TIMESTAMPTZ(6);

ALTER TABLE "users"
ADD CONSTRAINT "users_failed_login_attempts_check"
CHECK ("failed_login_attempts" >= 0);

ALTER TABLE "users"
ADD CONSTRAINT "users_last_totp_counter_check"
CHECK ("last_totp_counter" IS NULL OR "last_totp_counter" >= 0);

CREATE TABLE "staff_sessions" (
  "session_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "ip_address" VARCHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("session_id")
);

CREATE INDEX "staff_sessions_user_id_revoked_at_idx"
ON "staff_sessions"("user_id", "revoked_at");

CREATE INDEX "staff_sessions_expires_at_idx"
ON "staff_sessions"("expires_at");

ALTER TABLE "staff_sessions"
ADD CONSTRAINT "staff_sessions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
ON DELETE CASCADE ON UPDATE CASCADE;
