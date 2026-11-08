-- CreateEnum
CREATE TYPE "BurialReferralStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'NEEDS_CORRECTION', 'READY', 'ISSUED', 'CLOSED');

-- CreateTable
CREATE TABLE "burial_referrals" (
    "referral_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "status" "BurialReferralStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deceased_name" VARCHAR(150) NOT NULL,
    "death_date" DATE NOT NULL,
    "relationship" VARCHAR(100) NOT NULL,
    "purpose" VARCHAR(1500) NOT NULL,
    "receiving_office" VARCHAR(150) NOT NULL,
    "receiving_address" VARCHAR(300) NOT NULL,
    "sending_office" VARCHAR(150) NOT NULL,
    "signatory_name" VARCHAR(150) NOT NULL,
    "signatory_position" VARCHAR(150) NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "letter_snapshot" JSONB,
    "letter_hash" VARCHAR(64),
    "review_note" VARCHAR(1500),
    "issue_reference" VARCHAR(300),
    "response_outcome" VARCHAR(30),
    "response_reference" VARCHAR(300),
    "response_note" VARCHAR(1500),
    "created_by" UUID NOT NULL,
    "reviewed_by" UUID,
    "issued_by" UUID,
    "closed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "burial_referrals_pkey" PRIMARY KEY ("referral_id")
);

-- CreateIndex
CREATE INDEX "burial_referrals_beneficiary_id_created_at_idx" ON "burial_referrals"("beneficiary_id", "created_at");

-- CreateIndex
CREATE INDEX "burial_referrals_status_created_at_idx" ON "burial_referrals"("status", "created_at");

-- AddForeignKey
ALTER TABLE "burial_referrals" ADD CONSTRAINT "burial_referrals_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burial_referrals" ADD CONSTRAINT "burial_referrals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burial_referrals" ADD CONSTRAINT "burial_referrals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burial_referrals" ADD CONSTRAINT "burial_referrals_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "burial_referrals" ADD CONSTRAINT "burial_referrals_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
