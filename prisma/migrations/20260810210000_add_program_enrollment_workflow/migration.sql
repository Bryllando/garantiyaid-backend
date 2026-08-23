CREATE TYPE "ProgramStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');

ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'FOR_VALIDATION';
ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'NEEDS_CORRECTION';

ALTER TABLE "programs"
ADD COLUMN "budget_amount" DECIMAL(14,2),
ADD COLUMN "application_start_date" DATE,
ADD COLUMN "application_end_date" DATE,
ADD COLUMN "required_document_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "status" "ProgramStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "created_by" UUID,
ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "programs"
SET "status" = CASE WHEN "is_active" THEN 'ACTIVE'::"ProgramStatus" ELSE 'CLOSED'::"ProgramStatus" END;

UPDATE "programs"
SET "created_by" = (
  SELECT "user_id"
  FROM "users"
  WHERE "role" IN ('DSWD_STAFF', 'SYSTEM_ADMIN')
  ORDER BY CASE WHEN "role" = 'DSWD_STAFF' THEN 0 ELSE 1 END, "created_at"
  LIMIT 1
)
WHERE "created_by" IS NULL;

ALTER TABLE "programs" ALTER COLUMN "created_by" SET NOT NULL;
ALTER TABLE "programs" DROP COLUMN "is_active";

ALTER TABLE "enrollments" DROP CONSTRAINT IF EXISTS "enrollments_approved_by_fkey";
ALTER TABLE "enrollments" RENAME COLUMN "approved_by" TO "reviewed_by";
ALTER TABLE "enrollments"
ADD COLUMN "submitted_by" UUID,
ADD COLUMN "review_notes" TEXT,
ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);

UPDATE "enrollments"
SET "submitted_by" = COALESCE(
  "reviewed_by",
  (
    SELECT "user_id"
    FROM "users"
    WHERE "role" IN ('BARANGAY_FACILITATOR', 'SYSTEM_ADMIN')
    ORDER BY CASE WHEN "role" = 'BARANGAY_FACILITATOR' THEN 0 ELSE 1 END, "created_at"
    LIMIT 1
  )
)
WHERE "submitted_by" IS NULL;

ALTER TABLE "enrollments" ALTER COLUMN "submitted_by" SET NOT NULL;

ALTER TABLE "beneficiary_documents"
ADD COLUMN "original_file_name" VARCHAR(255),
ADD COLUMN "mime_type" VARCHAR(100),
ADD COLUMN "file_size" INTEGER,
ADD COLUMN "checksum" VARCHAR(64);

UPDATE "beneficiary_documents"
SET "original_file_name" = 'legacy-document',
    "mime_type" = 'application/octet-stream',
    "file_size" = 0,
    "checksum" = REPEAT('0', 64)
WHERE "original_file_name" IS NULL;

ALTER TABLE "beneficiary_documents"
ALTER COLUMN "original_file_name" SET NOT NULL,
ALTER COLUMN "mime_type" SET NOT NULL,
ALTER COLUMN "file_size" SET NOT NULL,
ALTER COLUMN "checksum" SET NOT NULL;

ALTER TABLE "programs"
ADD CONSTRAINT "programs_created_by_fkey"
FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enrollments"
ADD CONSTRAINT "enrollments_submitted_by_fkey"
FOREIGN KEY ("submitted_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "enrollments"
ADD CONSTRAINT "enrollments_reviewed_by_fkey"
FOREIGN KEY ("reviewed_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "programs_status_idx" ON "programs"("status");
CREATE INDEX "enrollments_program_id_status_idx" ON "enrollments"("program_id", "status");
CREATE INDEX "enrollments_status_idx" ON "enrollments"("status");
CREATE INDEX "beneficiary_documents_beneficiary_id_doc_type_idx"
ON "beneficiary_documents"("beneficiary_id", "doc_type");
