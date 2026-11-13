-- Opt-in only: existing events and claims keep their original requirements.
ALTER TABLE "distributions" ADD COLUMN "manual_verification_basis" VARCHAR(1000);
ALTER TABLE "claims" ADD COLUMN "manual_verification" JSONB;
