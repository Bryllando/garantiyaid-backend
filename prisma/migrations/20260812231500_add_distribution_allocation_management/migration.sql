ALTER TABLE "distribution_allocations"
ADD CONSTRAINT "distribution_allocations_amount_check"
CHECK ("amount" > 0);

CREATE UNIQUE INDEX "distribution_allocations_distribution_id_enrollment_id_key"
ON "distribution_allocations"("distribution_id", "enrollment_id");

CREATE INDEX "distribution_allocations_distribution_id_allocation_status_created_at_idx"
ON "distribution_allocations"("distribution_id", "allocation_status", "created_at");

CREATE INDEX "distribution_allocations_enrollment_id_idx"
ON "distribution_allocations"("enrollment_id");

CREATE TABLE "idempotency_records" (
  "idempotency_record_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "operation" VARCHAR(150) NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response_status" INTEGER NOT NULL,
  "response_body" JSONB NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("idempotency_record_id"),
  CONSTRAINT "idempotency_records_response_status_check"
    CHECK ("response_status" BETWEEN 200 AND 599),
  CONSTRAINT "idempotency_records_expiry_check"
    CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "idempotency_records_user_id_operation_idempotency_key_key"
ON "idempotency_records"("user_id", "operation", "idempotency_key");

CREATE INDEX "idempotency_records_expires_at_idx"
ON "idempotency_records"("expires_at");

ALTER TABLE "idempotency_records"
ADD CONSTRAINT "idempotency_records_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("user_id")
ON DELETE CASCADE ON UPDATE CASCADE;
