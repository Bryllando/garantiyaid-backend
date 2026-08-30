ALTER TYPE "VerificationMethod" ADD VALUE IF NOT EXISTS 'BIOMETRIC_AND_SIGNATURE';

ALTER TABLE "claims"
ADD COLUMN "signature_verified" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "claim_signatures" (
    "signature_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "captured_by" UUID NOT NULL,
    "encrypted_image" BYTEA NOT NULL,
    "image_sha256" VARCHAR(64) NOT NULL,
    "signature_method" VARCHAR(20) NOT NULL DEFAULT 'DRAWN',
    "point_count" INTEGER,
    "device_info" VARCHAR(255),
    "signed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_signatures_pkey" PRIMARY KEY ("signature_id"),
    CONSTRAINT "claim_signatures_method_check" CHECK (
        ("signature_method" = 'DRAWN' AND "point_count" >= 8)
        OR ("signature_method" = 'TYPED' AND "point_count" IS NULL)
    )
);

CREATE UNIQUE INDEX "claim_signatures_claim_id_key" ON "claim_signatures"("claim_id");
CREATE INDEX "claim_signatures_captured_by_signed_at_idx" ON "claim_signatures"("captured_by", "signed_at");

ALTER TABLE "claim_signatures"
ADD CONSTRAINT "claim_signatures_claim_id_fkey"
FOREIGN KEY ("claim_id") REFERENCES "claims"("claim_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "claim_signatures"
ADD CONSTRAINT "claim_signatures_captured_by_fkey"
FOREIGN KEY ("captured_by") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
