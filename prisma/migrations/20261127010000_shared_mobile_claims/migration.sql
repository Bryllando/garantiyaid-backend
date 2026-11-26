CREATE TABLE "beneficiary_mobile_accounts" (
  "account_id" UUID NOT NULL,
  "link_id" UUID,
  "registration" JSONB NOT NULL,
  "contact_number" VARCHAR(20) NOT NULL,
  "verified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "beneficiary_mobile_accounts_pkey" PRIMARY KEY ("account_id")
);
CREATE UNIQUE INDEX "beneficiary_mobile_accounts_link_id_key" ON "beneficiary_mobile_accounts"("link_id");
CREATE UNIQUE INDEX "beneficiary_mobile_accounts_contact_number_key" ON "beneficiary_mobile_accounts"("contact_number");
ALTER TABLE "beneficiary_mobile_accounts" ADD CONSTRAINT "beneficiary_mobile_accounts_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "mobile_beneficiary_accounts"("account_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "beneficiary_mobile_otps" (
  "challenge_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "purpose" VARCHAR(10) NOT NULL,
  "code_hash" CHAR(64) NOT NULL,
  "attempts_remaining" INTEGER NOT NULL DEFAULT 5,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "beneficiary_mobile_otps_pkey" PRIMARY KEY ("challenge_id")
);
CREATE INDEX "beneficiary_mobile_otps_account_id_created_at_idx" ON "beneficiary_mobile_otps"("account_id", "created_at");
ALTER TABLE "beneficiary_mobile_otps" ADD CONSTRAINT "beneficiary_mobile_otps_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "beneficiary_mobile_accounts"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "beneficiary_mobile_sessions" (
  "session_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "beneficiary_mobile_sessions_pkey" PRIMARY KEY ("session_id")
);
CREATE UNIQUE INDEX "beneficiary_mobile_sessions_token_hash_key" ON "beneficiary_mobile_sessions"("token_hash");
CREATE INDEX "beneficiary_mobile_sessions_account_id_expires_at_idx" ON "beneficiary_mobile_sessions"("account_id", "expires_at");
ALTER TABLE "beneficiary_mobile_sessions" ADD CONSTRAINT "beneficiary_mobile_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "beneficiary_mobile_accounts"("account_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve development accounts while separating test credentials from SMS authentication.
ALTER TABLE "beneficiary_mobile_otps"
  ADD COLUMN "delivery_mode" VARCHAR(20) NOT NULL DEFAULT 'DEVELOPMENT',
  ADD COLUMN "delivery_accepted_at" TIMESTAMPTZ(6);

-- Earlier challenges were issued only in development mode.
UPDATE "beneficiary_mobile_otps" SET "delivery_accepted_at" = "created_at";

ALTER TABLE "beneficiary_mobile_sessions"
  ADD COLUMN "auth_mode" VARCHAR(20) NOT NULL DEFAULT 'DEVELOPMENT';

ALTER TABLE "beneficiary_documents" ALTER COLUMN "uploaded_by" DROP NOT NULL;
ALTER TABLE "beneficiary_documents" ADD COLUMN "uploaded_by_beneficiary" UUID;
ALTER TABLE "beneficiary_documents" ADD CONSTRAINT "beneficiary_documents_uploaded_by_beneficiary_fkey"
  FOREIGN KEY ("uploaded_by_beneficiary") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "beneficiary_documents" ADD CONSTRAINT "beneficiary_documents_uploader_check" CHECK (
  ("uploaded_by" IS NOT NULL AND "uploaded_by_beneficiary" IS NULL)
  OR ("uploaded_by" IS NULL AND "uploaded_by_beneficiary" IS NOT NULL AND "uploaded_by_beneficiary" = "beneficiary_id")
);

ALTER TABLE "biometric_consents"
  ALTER COLUMN "recorded_by" DROP NOT NULL,
  ADD COLUMN "recorded_by_beneficiary" UUID;

ALTER TABLE "biometric_consents"
  ADD CONSTRAINT "biometric_consents_self_recorder_fkey"
    FOREIGN KEY ("recorded_by_beneficiary") REFERENCES "beneficiaries"("beneficiary_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "biometric_consents_recorder_check" CHECK (
    ("recorded_by" IS NOT NULL AND "recorded_by_beneficiary" IS NULL)
    OR ("recorded_by" IS NULL AND "recorded_by_beneficiary" IS NOT NULL AND "recorded_by_beneficiary" = "beneficiary_id")
  );

CREATE INDEX "biometric_consents_beneficiary_id_created_at_idx" ON "biometric_consents"("beneficiary_id", "created_at");

-- Preserve existing delivery records; mobile read state is independent of SMS delivery.
ALTER TABLE "notifications"
  ADD COLUMN "message_bs" TEXT,
  ADD COLUMN "read_at" TIMESTAMPTZ(6);

ALTER TABLE "mobile_beneficiary_accounts"
  ADD COLUMN "identity_status" VARCHAR(30) NOT NULL DEFAULT 'REQUIRED',
  ADD COLUMN "identity_document_id" UUID REFERENCES "beneficiary_documents"("document_id"),
  ADD COLUMN "identity_consent_id" UUID REFERENCES "biometric_consents"("consent_id"),
  ADD COLUMN "identity_note" VARCHAR(500),
  ADD CONSTRAINT "mobile_identity_state" CHECK ("identity_status" IN ('REQUIRED','CORRECTION','MATCHED','APPROVED'));

ALTER TABLE "claims"
  ADD COLUMN "settlement_authorized_by" UUID REFERENCES "users"("user_id"),
  ADD COLUMN "settlement_amount" DECIMAL(14,2),
  ADD CONSTRAINT "claim_settlement_authorization" CHECK (("settlement_authorized_by" IS NULL) = ("settlement_amount" IS NULL));
