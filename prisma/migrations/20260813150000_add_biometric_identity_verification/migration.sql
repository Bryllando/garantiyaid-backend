-- Phase 7: consent-bound encrypted biometric templates and identity-verification attempts.
-- Existing distribution events remain QR-only for backward compatibility.

CREATE TYPE "BiometricDataStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

ALTER TABLE "distributions"
ADD COLUMN "verification_requirement" "VerificationMethod" NOT NULL DEFAULT 'QR';

ALTER TABLE "biometric_data"
ADD COLUMN "data_status" "BiometricDataStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE "biometric_verification_attempts" (
  "attempt_id" UUID NOT NULL,
  "distribution_id" UUID,
  "beneficiary_id" UUID NOT NULL,
  "biometric_id" UUID,
  "claim_id" UUID,
  "verified_by" UUID NOT NULL,
  "result" VARCHAR(30) NOT NULL,
  "match_score" DECIMAL(5,4),
  "liveness_score" DECIMAL(5,4),
  "device_info" VARCHAR(255),
  "processor" VARCHAR(50) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "biometric_verification_attempts_pkey" PRIMARY KEY ("attempt_id")
);

CREATE INDEX "biometric_attempt_distribution_result_created_idx"
ON "biometric_verification_attempts"("distribution_id", "result", "created_at");

CREATE INDEX "biometric_attempt_beneficiary_created_idx"
ON "biometric_verification_attempts"("beneficiary_id", "created_at");

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_distribution_fkey"
FOREIGN KEY ("distribution_id") REFERENCES "distributions"("distribution_id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_beneficiary_fkey"
FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_biometric_fkey"
FOREIGN KEY ("biometric_id") REFERENCES "biometric_data"("biometric_id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_claim_fkey"
FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_verifier_fkey"
FOREIGN KEY ("verified_by") REFERENCES "users"("user_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "biometric_verification_attempts"
ADD CONSTRAINT "biometric_attempt_scores_check"
CHECK (
  ("match_score" IS NULL OR ("match_score" >= 0 AND "match_score" <= 1))
  AND ("liveness_score" IS NULL OR ("liveness_score" >= 0 AND "liveness_score" <= 1))
);
