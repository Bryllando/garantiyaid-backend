-- Preserve invalid or unknown QR scan attempts without storing the submitted raw token.
ALTER TABLE "qr_scan_logs"
ALTER COLUMN "qr_token_id" DROP NOT NULL,
ADD COLUMN "distribution_id" UUID,
ADD COLUMN "submitted_token_hash" VARCHAR(64);

-- Preserve event scope for any existing scan rows before adding the relation.
UPDATE "qr_scan_logs" AS scan
SET "distribution_id" = token."distribution_id"
FROM "qr_tokens" AS token
WHERE scan."qr_token_id" = token."qr_token_id";

ALTER TABLE "qr_scan_logs"
ADD CONSTRAINT "qr_scan_logs_distribution_id_fkey"
FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Monitoring and lifecycle lookup indexes for Phase 5.
CREATE INDEX "qr_tokens_distribution_id_qr_status_expires_at_idx"
ON "qr_tokens"("distribution_id", "qr_status", "expire_at");

CREATE INDEX "qr_scan_logs_qr_token_id_scanned_at_idx"
ON "qr_scan_logs"("qr_token_id", "scanned_at");

CREATE INDEX "qr_scan_logs_distribution_id_scan_result_scanned_at_idx"
ON "qr_scan_logs"("distribution_id", "scan_result", "scanned_at");

CREATE INDEX "qr_scan_logs_submitted_token_hash_scanned_at_idx"
ON "qr_scan_logs"("submitted_token_hash", "scanned_at");

CREATE INDEX "qr_scan_logs_scan_result_scanned_at_idx"
ON "qr_scan_logs"("scan_result", "scanned_at");

CREATE INDEX "claims_distribution_id_claim_status_created_at_idx"
ON "claims"("distribution_id", "claim_status", "created_at");
