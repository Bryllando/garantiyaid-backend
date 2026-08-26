CREATE TABLE "staff_recovery_codes" (
  "recovery_code_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "staff_recovery_codes_pkey" PRIMARY KEY ("recovery_code_id")
);

CREATE UNIQUE INDEX "staff_recovery_codes_code_hash_key"
ON "staff_recovery_codes"("code_hash");

CREATE INDEX "staff_recovery_codes_user_id_used_at_idx"
ON "staff_recovery_codes"("user_id", "used_at");

ALTER TABLE "staff_recovery_codes"
ADD CONSTRAINT "staff_recovery_codes_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
ON DELETE CASCADE ON UPDATE CASCADE;
