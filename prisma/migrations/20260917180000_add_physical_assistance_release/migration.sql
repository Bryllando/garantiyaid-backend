CREATE TYPE "AssistanceDeliveryMode" AS ENUM ('PHYSICAL_GOODS', 'SIMULATED_WALLET');
CREATE TYPE "ReleaseEvidenceType" AS ENUM ('SIGNED_ACKNOWLEDGEMENT', 'OFFICIAL_RELEASE_LOG', 'PHOTO_REFERENCE', 'OTHER');

ALTER TABLE "distributions"
ADD COLUMN "delivery_mode" "AssistanceDeliveryMode" NOT NULL DEFAULT 'SIMULATED_WALLET';

ALTER TABLE "claims"
ADD COLUMN "release_method" "AssistanceDeliveryMode",
ADD COLUMN "released_by" UUID,
ADD COLUMN "released_at" TIMESTAMPTZ(6),
ADD COLUMN "release_evidence_type" "ReleaseEvidenceType",
ADD COLUMN "release_evidence_reference" VARCHAR(120),
ADD COLUMN "release_notes" VARCHAR(1000),
ADD CONSTRAINT "claims_released_by_fkey"
  FOREIGN KEY ("released_by") REFERENCES "users"("user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing completed claims came from the simulated wallet workflow.
UPDATE "claims" AS claim
SET
  "release_method" = 'SIMULATED_WALLET',
  "released_by" = transaction."initiated_by",
  "released_at" = COALESCE(claim."claimed_at", transaction."created_at")
FROM "transactions" AS transaction
WHERE transaction."claim_id" = claim."claim_id"
  AND transaction."transaction_type" = 'BENEFIT_CREDIT'
  AND claim."claim_status" IN ('CLAIMED', 'VOIDED');

CREATE INDEX "claims_released_by_released_at_idx"
ON "claims"("released_by", "released_at");
