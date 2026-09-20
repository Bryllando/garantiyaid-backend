CREATE TABLE "staff_password_reset_tokens" (
  "reset_token_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_password_reset_tokens_pkey" PRIMARY KEY ("reset_token_id")
);

CREATE UNIQUE INDEX "staff_password_reset_tokens_token_hash_key"
  ON "staff_password_reset_tokens"("token_hash");
CREATE INDEX "staff_password_reset_tokens_user_id_used_at_idx"
  ON "staff_password_reset_tokens"("user_id", "used_at");
CREATE INDEX "staff_password_reset_tokens_expires_at_idx"
  ON "staff_password_reset_tokens"("expires_at");

ALTER TABLE "staff_password_reset_tokens"
  ADD CONSTRAINT "staff_password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
