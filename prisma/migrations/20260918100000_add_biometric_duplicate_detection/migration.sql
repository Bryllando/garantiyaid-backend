ALTER TYPE "BiometricDataStatus" ADD VALUE 'PENDING_DUPLICATE_REVIEW';
ALTER TYPE "BiometricDataStatus" ADD VALUE 'DUPLICATE_BLOCKED';

CREATE TYPE "BiometricDuplicateCaseStatus" AS ENUM ('PENDING', 'CLEARED', 'CONFIRMED');

CREATE TABLE "biometric_duplicate_cases" (
  "duplicate_case_id" UUID NOT NULL,
  "candidate_beneficiary_id" UUID NOT NULL,
  "matched_beneficiary_id" UUID NOT NULL,
  "candidate_biometric_id" UUID,
  "matched_biometric_id" UUID,
  "match_score" DECIMAL(5,4) NOT NULL,
  "match_threshold" DECIMAL(5,4) NOT NULL,
  "status" "BiometricDuplicateCaseStatus" NOT NULL DEFAULT 'PENDING',
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewed_by" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "review_notes" VARCHAR(1000),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "biometric_duplicate_cases_pkey" PRIMARY KEY ("duplicate_case_id"),
  CONSTRAINT "biometric_duplicate_cases_distinct_beneficiaries_check"
    CHECK ("candidate_beneficiary_id" <> "matched_beneficiary_id"),
  CONSTRAINT "biometric_duplicate_cases_score_check"
    CHECK ("match_score" >= 0 AND "match_score" <= 1),
  CONSTRAINT "biometric_duplicate_cases_threshold_check"
    CHECK ("match_threshold" >= 0 AND "match_threshold" <= 1)
);

ALTER TABLE "biometric_duplicate_cases"
  ADD CONSTRAINT "biometric_duplicate_cases_candidate_beneficiary_fkey"
    FOREIGN KEY ("candidate_beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "biometric_duplicate_cases_matched_beneficiary_fkey"
    FOREIGN KEY ("matched_beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "biometric_duplicate_cases_candidate_biometric_fkey"
    FOREIGN KEY ("candidate_biometric_id") REFERENCES "biometric_data"("biometric_id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "biometric_duplicate_cases_matched_biometric_fkey"
    FOREIGN KEY ("matched_biometric_id") REFERENCES "biometric_data"("biometric_id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "biometric_duplicate_cases_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "biometric_duplicate_cases_status_detected_at_idx"
  ON "biometric_duplicate_cases"("status", "detected_at");
CREATE INDEX "biometric_duplicate_cases_candidate_beneficiary_status_idx"
  ON "biometric_duplicate_cases"("candidate_beneficiary_id", "status");
CREATE INDEX "biometric_duplicate_cases_matched_beneficiary_status_idx"
  ON "biometric_duplicate_cases"("matched_beneficiary_id", "status");

-- One unresolved duplicate decision per candidate template prevents competing reviews.
CREATE UNIQUE INDEX "biometric_duplicate_cases_one_pending_candidate_idx"
  ON "biometric_duplicate_cases"("candidate_biometric_id")
  WHERE "status" = 'PENDING' AND "candidate_biometric_id" IS NOT NULL;
