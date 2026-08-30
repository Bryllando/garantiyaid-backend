CREATE TYPE "ClaimDisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'REFERRED', 'RESOLVED');
CREATE TYPE "ClaimDisputeReason" AS ENUM ('BENEFICIARY_DENIES_RECEIPT', 'AMOUNT_OR_ASSISTANCE_MISMATCH', 'SUSPECTED_IDENTITY_MISUSE', 'RECEIPT_OR_RECORD_ERROR', 'OTHER');
CREATE TYPE "ClaimDisputeOutcome" AS ENUM ('CLAIM_CONFIRMED', 'BENEFICIARY_REMEDIATION', 'REFERRED_FOR_INVESTIGATION');

CREATE TABLE "claim_receipts" (
  "receipt_id" UUID NOT NULL,
  "claim_id" UUID NOT NULL,
  "issued_by" UUID NOT NULL,
  "receipt_no" VARCHAR(60) NOT NULL,
  "receipt_version" VARCHAR(30) NOT NULL DEFAULT 'GYA-CLAIM-1',
  "evidence_hash" VARCHAR(64) NOT NULL,
  "snapshot" JSONB NOT NULL,
  "print_count" INTEGER NOT NULL DEFAULT 0,
  "last_printed_at" TIMESTAMPTZ(6),
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_receipts_pkey" PRIMARY KEY ("receipt_id")
);

CREATE TABLE "claim_disputes" (
  "dispute_id" UUID NOT NULL,
  "claim_id" UUID NOT NULL,
  "filed_by" UUID NOT NULL,
  "assigned_to" UUID,
  "reviewed_by" UUID,
  "reference_no" VARCHAR(60) NOT NULL,
  "status" "ClaimDisputeStatus" NOT NULL DEFAULT 'OPEN',
  "reason_code" "ClaimDisputeReason" NOT NULL,
  "statement" TEXT NOT NULL,
  "outcome" "ClaimDisputeOutcome",
  "review_notes" TEXT,
  "filed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_at" TIMESTAMPTZ(6),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "claim_disputes_pkey" PRIMARY KEY ("dispute_id")
);

CREATE UNIQUE INDEX "claim_receipts_claim_id_key" ON "claim_receipts"("claim_id");
CREATE UNIQUE INDEX "claim_receipts_receipt_no_key" ON "claim_receipts"("receipt_no");
CREATE INDEX "claim_receipts_issued_by_issued_at_idx" ON "claim_receipts"("issued_by", "issued_at");
CREATE UNIQUE INDEX "claim_disputes_reference_no_key" ON "claim_disputes"("reference_no");
CREATE UNIQUE INDEX "claim_disputes_one_active_per_claim_key" ON "claim_disputes"("claim_id") WHERE "status" IN ('OPEN', 'UNDER_REVIEW', 'REFERRED');
CREATE INDEX "claim_disputes_claim_id_status_filed_at_idx" ON "claim_disputes"("claim_id", "status", "filed_at");
CREATE INDEX "claim_disputes_status_filed_at_idx" ON "claim_disputes"("status", "filed_at");
CREATE INDEX "claim_disputes_assigned_to_status_idx" ON "claim_disputes"("assigned_to", "status");

ALTER TABLE "claim_receipts" ADD CONSTRAINT "claim_receipts_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_receipts" ADD CONSTRAINT "claim_receipts_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_filed_by_fkey" FOREIGN KEY ("filed_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "claim_disputes" ADD CONSTRAINT "claim_disputes_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
