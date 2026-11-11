CREATE TYPE "MobileAccountLinkStatus" AS ENUM ('PENDING', 'LINKED', 'REJECTED');

CREATE TABLE "mobile_beneficiary_accounts" (
    "account_id" UUID NOT NULL,
    "issuer" VARCHAR(200) NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "MobileAccountLinkStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "first_name" VARCHAR(100) NOT NULL,
    "middle_name" VARCHAR(100),
    "last_name" VARCHAR(100) NOT NULL,
    "birth_date" DATE NOT NULL,
    "barangay_id" UUID NOT NULL,
    "beneficiary_id" UUID,
    "reviewed_by_id" UUID,
    "review_note" VARCHAR(2000),
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "mobile_beneficiary_accounts_pkey" PRIMARY KEY ("account_id"),
    CONSTRAINT "mobile_beneficiary_accounts_link_state_check" CHECK (
      ("status" = 'LINKED') = ("beneficiary_id" IS NOT NULL)
    ),
    CONSTRAINT "mobile_beneficiary_accounts_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "mobile_beneficiary_accounts_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "mobile_beneficiary_accounts_issuer_subject_key" ON "mobile_beneficiary_accounts"("issuer", "subject");
CREATE UNIQUE INDEX "mobile_beneficiary_accounts_beneficiary_id_key" ON "mobile_beneficiary_accounts"("beneficiary_id");
CREATE INDEX "mobile_beneficiary_accounts_barangay_id_status_created_at_idx" ON "mobile_beneficiary_accounts"("barangay_id", "status", "created_at");
