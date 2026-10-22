CREATE TABLE "beneficiary_import_jobs" (
  "import_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "scope_barangay_id" UUID,
  "request_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  "total_count" INTEGER NOT NULL,
  "processed_count" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "encrypted_rows" TEXT,
  "processing_token" UUID,
  "lease_until" TIMESTAMPTZ(6),
  "last_error" VARCHAR(300),
  "ip_address" VARCHAR(100),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "beneficiary_import_jobs_pkey" PRIMARY KEY ("import_id"),
  CONSTRAINT "beneficiary_import_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "beneficiary_import_jobs_user_id_created_at_idx" ON "beneficiary_import_jobs"("user_id", "created_at");
CREATE INDEX "beneficiary_import_jobs_status_lease_until_idx" ON "beneficiary_import_jobs"("status", "lease_until");
CREATE INDEX "beneficiary_import_jobs_expires_at_idx" ON "beneficiary_import_jobs"("expires_at");
CREATE TABLE "beneficiary_import_batches" (
  "import_id" UUID NOT NULL,
  "batch_index" INTEGER NOT NULL,
  "encrypted_result" TEXT NOT NULL,
  CONSTRAINT "beneficiary_import_batches_pkey" PRIMARY KEY ("import_id", "batch_index"),
  CONSTRAINT "beneficiary_import_batches_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "beneficiary_import_jobs"("import_id") ON DELETE CASCADE ON UPDATE CASCADE
);
