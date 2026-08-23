CREATE TYPE "DocumentReviewStatus" AS ENUM (
  'SUBMITTED',
  'ACCEPTED',
  'REJECTED',
  'SUPERSEDED'
);

ALTER TABLE "beneficiary_documents"
ADD COLUMN "review_status" "DocumentReviewStatus" NOT NULL DEFAULT 'SUBMITTED',
ADD COLUMN "reviewed_by" UUID,
ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
ADD COLUMN "review_notes" TEXT,
ADD COLUMN "replaces_document_id" UUID;

-- Existing documents predate formal document review. Grandfathering them as
-- accepted preserves already-approved enrollments without fabricating a reviewer.
UPDATE "beneficiary_documents"
SET "review_status" = 'ACCEPTED'::"DocumentReviewStatus";

ALTER TABLE "beneficiary_documents"
ADD CONSTRAINT "beneficiary_documents_reviewed_by_fkey"
FOREIGN KEY ("reviewed_by") REFERENCES "users"("user_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "beneficiary_documents"
ADD CONSTRAINT "beneficiary_documents_replaces_document_id_fkey"
FOREIGN KEY ("replaces_document_id") REFERENCES "beneficiary_documents"("document_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "beneficiary_documents"
ADD CONSTRAINT "beneficiary_documents_rejection_reason_check"
CHECK (
  "review_status" NOT IN ('REJECTED', 'SUPERSEDED')
  OR COALESCE(LENGTH(BTRIM("review_notes")), 0) >= 5
);

CREATE UNIQUE INDEX "beneficiary_documents_replaces_document_id_key"
ON "beneficiary_documents"("replaces_document_id");

CREATE INDEX "beneficiary_documents_beneficiary_id_doc_type_review_status_idx"
ON "beneficiary_documents"("beneficiary_id", "doc_type", "review_status");
